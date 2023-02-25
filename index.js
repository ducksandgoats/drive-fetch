module.exports = async function makeHyperFetch (opts = {}) {
  const { makeRoutedFetch } = await import('make-fetch')
  const {fetch, router} = makeRoutedFetch({onNotFound: handleEmpty, onError: handleError})
  const mime = require('mime/lite')
  const parseRange = require('range-parser')
  const { Readable, pipelinePromise } = require('streamx')
  const path = require('path')

  const DEFAULT_OPTS = {}
  const finalOpts = { ...DEFAULT_OPTS, ...opts }
  const app = await (async (finalOpts) => {if(finalOpts.sdk){return finalOpts.sdk}else{const SDK = await import('hyper-sdk');const sdk = await SDK.create(finalOpts);return sdk;}})(finalOpts)
  const hyperTimeout = 30000
  const hostType = '_'
  // const SUPPORTED_METHODS = ['GET', 'HEAD', 'POST', 'DELETE']

  const drives = new Map()
  const id = await (async () => {
    const drive = await app.getDrive('id')
    const check = drive.key.toString('hex')
    drives.set(check, drive)
    return check
  })()

  async function checkForDrive(prop){
    if(drives.has(prop)){
      return drives.get(prop)
    }
    const drive = await app.getDrive(prop)
    drives.set(drive.key.toString('hex'), drive)
    return drive
  }

  async function waitForStuff(useTo, mainData) {
    if (useTo.num) {
      return await Promise.race([
        new Promise((resolve, reject) => setTimeout(() => { const err = new Error(`${useTo.msg} timed out`); err.name = 'TimeoutError'; reject(err); })),
        mainData
      ])
    } else {
      return await mainData
    }
  }

  function handleEmpty(request) {
    const { url, headers: reqHeaders, method, body, signal } = request
    if(signal){
      signal.removeEventListener('abort', takeCareOfIt)
    }
    const mainReq = !reqHeaders.has('accept') || !reqHeaders.get('accept').includes('application/json')
    const mainRes = mainReq ? 'text/html; charset=utf-8' : 'application/json; charset=utf-8'
    return {status: 400, headers: { 'Content-Type': mainRes }, body: mainReq ? `<html><head><title>${url}</title></head><body><div><p>did not find any data</p></div></body></html>` : JSON.stringify('did not find any data')}
  }

  function handleError(e, request) {
    const { url, headers: reqHeaders, method, body, signal } = request
    if(signal){
      signal.removeEventListener('abort', takeCareOfIt)
    }
    const mainReq = !reqHeaders.has('accept') || !reqHeaders.get('accept').includes('application/json')
    const mainRes = mainReq ? 'text/html; charset=utf-8' : 'application/json; charset=utf-8'
    return {status: 500, headers: { 'X-Error': e.name, 'Content-Type': mainRes }, body: mainReq ? `<html><head><title>${e.name}</title></head><body><div><p>${e.stack}</p></div></body></html>` : JSON.stringify(e.stack)}
  }

  function takeCareOfIt(data){
    console.log(data)
    throw new Error('aborted')
  }

  function sendTheData(theSignal, theData){
    if(theSignal){
      theSignal.removeEventListener('abort', takeCareOfIt)
    }
    return theData
  }

  function handleFormData(formdata){
    const arr = []
    for (const [name, info] of formdata) {
      if (name === 'file') {
        arr.push(info)
      }
    }
    return arr
  }

  function formatReq(hostname, pathname){

    const useData = {}
    if(hostname === hostType){
      useData.useHost = id
    } else {
      useData.useHost = hostname
    }
    useData.usePath = decodeURIComponent(pathname)
    return useData
  }

  async function saveFileData(drive, main, body, useOpt) {
    await pipelinePromise(Readable.from(body), drive.createWriteStream(main.usePath, useOpt))
    return [main.usePath]
  }

  async function saveFormData(drive, mid, data, useOpts) {
    const saved = []
    for (const info of data) {
        const usePath = path.join(mid.usePath, info.name).replace(/\\/g, "/")
      await pipelinePromise(Readable.from(info.stream()), drive.createWriteStream(usePath, useOpts))
      saved.push(usePath)
    }
    return saved
  }

  function getMimeType (path) {
    let mimeType = mime.getType(path) || 'text/plain'
    if (mimeType.startsWith('text/')) mimeType = `${mimeType}; charset=utf-8`
    return mimeType
  }

  async function handleHead(request) {
    const { url, headers: reqHeaders, method, signal, body } = request

    if(signal){
      signal.addEventListener('abort', takeCareOfIt)
    }

      const { hostname, pathname, protocol, search, searchParams } = new URL(url)

    const main = formatReq(decodeURIComponent(hostname), decodeURIComponent(pathname))
    const useOpts = { timeout: reqHeaders.has('x-timer') || searchParams.has('x-timer') ? reqHeaders.get('x-timer') !== '0' || searchParams.get('x-timer') !== '0' ? Number(reqHeaders.get('x-timer') || searchParams.get('x-timer')) * 1000 : undefined : hyperTimeout }
    
    if (reqHeaders.has('x-copy') || searchParams.has('x-copy')) {
      const useDrive = await waitForStuff({num: useOpts.timeout, msg: 'drive'}, checkForDrive(main.useHost))
      if (path.extname(main.usePath)) {
        const useData = await useDrive.entry(main.usePath)
        if (useData) {
          const pathToFile = JSON.parse(reqHeaders.get('x-copy') || searchParams.get('x-copy')) ? path.join(`/${useDrive.key.toString('hex')}`, useData.key).replace(/\\/g, "/") : useData.key
          const mainDrive = await checkForDrive(id)
          await mainDrive.put(pathToFile, await useDrive.get(useData.key))
          const useHeaders = {}
          useHeaders['X-Link'] = 'hyper://_' + pathToFile.replace(/\\/g, "/")
          useHeaders['Link'] = `<${useHeaders['X-Link']}>; rel="canonical"`
          return sendTheData(signal, {status: 200, headers: {'Content-Length': `${useData.value.blob.byteLength}`, ...useHeaders}, body: ''})
        } else {
          return sendTheData(signal, {status: 400, headers: {'X-Error': 'did not find any file'}, body: ''})
        }
      } else {
        const useIdenPath = JSON.parse(reqHeaders.get('x-copy') || searchParams.get('x-copy')) ? `/${useDrive.key.toString('hex')}` : '/'
        const mainDrive = await checkForDrive(id)
        let useNum = 0
        for await (const test of useDrive.list(main.usePath)) {
          useNum = useNum + test.value.blob.byteLength
          const pathToFile = path.join(useIdenPath, test.key).replace(/\\/g, "/")
          await mainDrive.put(pathToFile, await useDrive.get(test.key))
        }
        const pathToFolder = path.join(useIdenPath, main.usePath).replace(/\\/g, "/")
        const useHeaders = {}
        useHeaders['X-Link'] = 'hyper://_' + pathToFolder.replace(/\\/g, "/")
        useHeaders['Link'] = `<${useHeaders['X-Link']}>; rel="canonical"`
        return sendTheData(signal, { status: 200, headers: { 'Content-Length': `${useNum}`, ...useHeaders }, body: '' })
      }
    } else {
      const useDrive = await waitForStuff({num: useOpts.timeout, msg: 'drive'}, checkForDrive(main.useHost))
      if (path.extname(main.usePath)) {
        const useData = await useDrive.entry(main.usePath)
        if (useData) {
          const useLink = 'hyper://' + path.join(useDrive.key.toString('hex'), useData.key).replace(/\\/g, "/")
          return sendTheData(signal, { status: 200, headers: { 'Content-Length': String(useData.value.blob.byteLength), 'X-Link': useLink, 'Link': `<${useLink}>; rel="canonical"` }, body: '' })
        } else {
          return sendTheData(signal, {status: 400, headers: {'X-Error': 'did not find any file'}, body: ''})
        }
      } else {
        let useNum = 0
        for await (const test of useDrive.list(main.usePath)) {
          useNum = useNum + test.value.blob.byteLength
        }
        const useLink = 'hyper://' + path.join(useDrive.key.toString('hex'), main.usePath).replace(/\\/g, "/")
        return sendTheData(signal, { status: 200, headers: { 'Content-Length': String(useNum), 'X-Link': useLink, 'Link': `<${useLink}>; rel="canonical"` }, body: '' })
      }
    }
  }

  async function handleGet(request) {
    const { url, headers: reqHeaders, method, signal, body } = request

    if(signal){
      signal.addEventListener('abort', takeCareOfIt)
    }

      const { hostname, pathname, protocol, search, searchParams } = new URL(url)

      const main = formatReq(decodeURIComponent(hostname), decodeURIComponent(pathname))
      const useOpts = { timeout: reqHeaders.has('x-timer') || searchParams.has('x-timer') ? reqHeaders.get('x-timer') !== '0' || searchParams.get('x-timer') !== '0' ? Number(reqHeaders.get('x-timer') || searchParams.get('x-timer')) * 1000 : undefined : hyperTimeout }

      const mainReq = !reqHeaders.has('accept') || !reqHeaders.get('accept').includes('application/json')
    const mainRes = mainReq ? 'text/html; charset=utf-8' : 'application/json; charset=utf-8'

    const useDrive = await waitForStuff({num: useOpts.timeout, msg: 'drive'}, checkForDrive(main.useHost))
    if (path.extname) {
      const useData = await useDrive.entry(main.usePath)
      if (useData) {
        const useLink = 'hyper://' + path.join(useDrive.key.toString('hex'), useData.key).replace(/\\/g, "/")
        const isRanged = reqHeaders.has('Range') || reqHeaders.has('range')
        if(isRanged){
          const ranges = parseRange(useData.value.blob.byteLength, reqHeaders.get('Range') || reqHeaders.get('range'))
          // if (ranges && ranges.length && ranges.type === 'bytes') {
          if ((ranges !== -1 && ranges !== -2) && ranges.type === 'bytes') {
            const [{ start, end }] = ranges
            const length = (end - start + 1)
            return sendTheData(signal, {status: 206, headers: {'Content-Type': getMimeType(useData.key), 'X-Link': useLink, 'Link': `<${useLink}>; rel="canonical"`, 'Content-Length': `${length}`, 'Content-Range': `bytes ${start}-${end}/${useData.value.blob.byteLength}`}, body: useDrive.createReadStream(useData.key, {start, end})})
          } else {
            return sendTheData(signal, {status: 416, headers: {'Content-Type': mainRes, 'X-Link': useLink, 'Link': `<${useLink}>; rel="canonical"`, 'Content-Length': `${useData.value.blob.byteLength}`}, body: mainReq ? '<html><head><title>range</title></head><body><div><p>malformed or unsatisfiable range</p></div></body></html>' : JSON.stringify('malformed or unsatisfiable range')})
          }
        } else {
          return sendTheData(signal, {status: 200, headers: {'Content-Type': getMimeType(useData.key), 'X-Link': useLink, 'Link': `<${useLink}>; rel="canonical"`, 'Content-Length': `${useData.value.blob.byteLength}`}, body: useDrive.createReadStream(useData.key)})
        }
      } else {
        return sendTheData(signal, { status: 400, headers: { 'Content-Type': mainRes }, body: mainReq ? '<html><head><title>range</title></head><body><div><p>did not find any file</p></div></body></html>' : JSON.stringify('did not find any file') })
      }
    } else {
      const useLink = 'hyper://' + path.join(useDrive.key.toString('hex'), main.usePath).replace(/\\/g, "/")
        const arr = []
      for await (const test of useDrive.readdir(main.usePath)) {
          arr.push(path.join('/', test).replace(/\\/g, '/'))
        }
      return sendTheData(signal, {status: 200, headers: {'X-Link': useLink, 'Link': `<${useLink}>; rel="canonical"`, 'Content-Type': mainRes}, body: mainReq ? `<html><head><title>${main.usePath}</title></head><body><div><p><a href='../'>..</a></p>${arr.map((data) => {return `<p><a href="${data}">${data}</a></p>`})}</div></body></html>` : JSON.stringify(arr)})
    }
  }

  async function handlePost(request) {
    const { url, headers: reqHeaders, method, signal, body } = request

    if(signal){
      signal.addEventListener('abort', takeCareOfIt)
    }

      const { hostname, pathname, protocol, search, searchParams } = new URL(url)

      const main = formatReq(decodeURIComponent(hostname), decodeURIComponent(pathname))

      const mainReq = !reqHeaders.has('accept') || !reqHeaders.get('accept').includes('application/json')
      const mainRes = mainReq ? 'text/html; charset=utf-8' : 'application/json; charset=utf-8'
    
      const useDrive = await checkForDrive(main.useHost)
      const hasOpt = reqHeaders.has('x-opt') || searchParams.has('x-opt')
      const useOpt = hasOpt ? JSON.parse(reqHeaders.get('x-opt') || decodeURIComponent(searchParams.get('x-opt'))) : {}
    const saved = reqHeaders.has('content-type') && reqHeaders.get('content-type').includes('multipart/form-data') ? await saveFormData(useDrive, main, handleFormData(await request.formData()), useOpt) : await saveFileData(useDrive, main, body, useOpt)
    const useName = useDrive.key.toString('hex')
    saved.forEach((data, i) => {saved[i] = 'hyper://' + path.join(useName, data).replace(/\\/g, '/')})
    const useLink = 'hyper://' + path.join(useName, main.usePath).replace(/\\/g, '/')
      return sendTheData(signal, {status: 200, headers: {'Content-Type': mainRes, 'X-Link': useLink, 'Link': `<${useLink}>; rel="canonical"`}, body: mainReq ? `<html><head><title>Fetch</title></head><body><div>${JSON.stringify(saved)}</div></body></html>` : JSON.stringify(saved)})
  }

  async function handleDelete(request) {
    const { url, headers: reqHeaders, method, signal, body } = request

    if(signal){
      signal.addEventListener('abort', takeCareOfIt)
    }

      const { hostname, pathname, protocol, search, searchParams } = new URL(url)

      const main = formatReq(decodeURIComponent(hostname), decodeURIComponent(pathname))

      const mainReq = !reqHeaders.has('accept') || !reqHeaders.get('accept').includes('application/json')
      const mainRes = mainReq ? 'text/html; charset=utf-8' : 'application/json; charset=utf-8'
    
      const useDrive = await checkForDrive(main.useHost)
    if (path.extname(main.usePath)) {
      const useData = await useDrive.entry(main.usePath)
      if (useData) {
        await useDrive.del(useData.key)
        const useLink = 'hyper://' + path.join(useDrive.key.toString('hex'), useData.key).replace(/\\/g, '/')
        return sendTheData(signal, {status: 200, headers: {'Content-Type': mainRes, 'X-Link': useLink, 'Link': `<${useLink}>; rel="canonical"`, 'Content-Length': `${useData.value.blob.byteLength}`}, body: mainReq ? `<html><head><title>Fetch</title></head><body><div>${useLink}</div></body></html>` : JSON.stringify(useLink)})
      } else {
        return sendTheData(signal, { status: 400, headers: { 'Content-Type': mainRes }, body: mainReq ? '<html><head><title>range</title></head><body><div><p>did not find any file</p></div></body></html>' : JSON.stringify('did not find any file') })
      }
    } else {
        let useNum = 0
        for await (const test of useDrive.list(main.usePath)){
          useNum = useNum + test.value.blob.byteLength
          await useDrive.del(test.key)
      }
      const useLink = 'hyper://' + path.join(useDrive.key.toString('hex'), main.usePath).replace(/\\/g, '/')
      return sendTheData(signal, { status: 200, headers: { 'Content-Type': mainRes, 'X-Link': useLink, 'Link': `<${useLink}>; rel="canonical"`, 'Content-Length': `${useNum}` }, body: mainReq ? `<html><head><title>Fetch</title></head><body><div>${useLink}</div></body></html>` : JSON.stringify(useLink) })
    }
  }

  router.head('hyper://*/**', handleHead)
  router.get('hyper://*/**', handleGet)
  router.post('hyper://*/**', handlePost)
  router.delete('hyper://*/**', handleDelete)

  fetch.close = async () => {return await app.close()}

  return fetch
}