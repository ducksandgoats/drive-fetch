module.exports = async function makeHyperFetch (opts = {}) {
  const { makeRoutedFetch } = await import('make-fetch')
  const {fetch, router} = makeRoutedFetch()
  const mime = require('mime/lite')
  const parseRange = require('range-parser')
  const { Readable, pipelinePromise } = require('streamx')
  const path = require('path')

  const DEFAULT_OPTS = {}
  const finalOpts = { ...DEFAULT_OPTS, ...opts }
  const app = await (async (finalOpts) => {if(finalOpts.sdk){return finalOpts.sdk}else{const SDK = await import('hyper-sdk');const sdk = await SDK.create(finalOpts);return sdk;}})(finalOpts)
  const DEFAULT_TIMEOUT = 30000
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

  // function makeTimeOut(data, timeout, res, name = null){
  //   if(name){
  //     data.name = name
  //   }
  //   return new Promise((resolve, reject) => {setTimeout(() => {if(res){resolve(data)}else{reject(data)}}, timeout)})
  // }

  async function saveFileData(drive, main, body, useOpt, sec) {
    await Promise.race([
      pipelinePromise(Readable.from(body), drive.createWriteStream(main.usePath, useOpts)),
      new Promise((resolve, reject) => setTimeout(reject, sec))
    ])
    return [main.usePath]
  }

  async function saveFormData(drive, mid, data, useOpts, sec) {
    const saved = []
    const iter = []
    for (const info of data) {
        const usePath = path.join(mid.usePath, info.name).replace(/\\/g, "/")
        saved.push(usePath)
        iter.push(
          Promise.race([
            pipelinePromise(Readable.from(info.stream()), drive.createWriteStream(usePath, useOpts)),
            new Promise((resolve, reject) => setTimeout(reject, sec))
          ])
        )
    }
    await Promise.all(iter)
    return saved
  }

  async function iterFiles(drive, data, timer, main){
    const result = []
    for(const i of data){
      const useData = {}
      const check = await Promise.race([
        drive.entry(i),
        new Promise((resolve, reject) => setTimeout(reject, timer))
      ])
      try {
        useData.pid  = drive.key.toString('hex')
        useData.file = check.key
        useData.link = `hyper://${useData.pid}${useData.file}`
      } catch (err) {
        console.error(err)
        useData.error = err
        useData.pid  = drive.key.toString('hex')
        useData.file = check.key
      }
      result.push(useData)
    }
    return result
  }

  async function iterFile(drive, resObj, main, timer){
    const check = await Promise.race([
      drive.entry(main.usePath),
      new Promise((resolve, reject) => setTimeout(reject, timer))
    ])
    try {
      resObj.pid  = drive.key.toString('hex')
      resObj.file = check.key
      resObj.link = `hyper://${resObj.pid}${resObj.file}`
    } catch (err) {
      console.error(err)
      resObj.error = err
      resObj.pid  = drive.key.toString('hex')
      resObj.file = check.key
    }
    return resObj
  }

  function getMimeType (path) {
    let mimeType = mime.getType(path) || 'text/plain'
    if (mimeType.startsWith('text/')) mimeType = `${mimeType}; charset=utf-8`
    return mimeType
  }

  // async function collect (iterable) {
  //   const result = []
  //   for await (const item of iterable) {
  //     result.push(item)
  //   }
  // }

  async function handleHead(request) {
    const { url, headers: reqHeaders, method, signal, body } = request

    if(signal){
      signal.addEventListener('abort', takeCareOfIt)
    }

      const { hostname, pathname, protocol, search, searchParams } = new URL(url)

      const main = formatReq(decodeURIComponent(hostname), decodeURIComponent(pathname))
      const useTimeOut = (reqHeaders.has('x-timer') && reqHeaders.get('x-timer') !== '0') || (searchParams.has('x-timer') && searchParams.get('x-timer') !== '0') ? Number(reqHeaders.get('x-timer') || searchParams.get('x-timer')) * 1000 : DEFAULT_TIMEOUT
    
      if (reqHeaders.has('x-copy')) {
        const useDrive = await checkForDrive(main.useHost)
        const useData = await Promise.race([
          useDrive.entry(main.usePath),
          new Promise((resolve, reject) => setTimeout(reject, useTimeOut))
        ])
        if (useData) {
          const pathToFile = JSON.parse(reqHeaders.get('x-copy')) ? path.join(`/${useDrive.key.toString('hex')}`, useData.key).replace(/\\/g, "/") : useData.key
            const mainDrive = await checkForDrive(id)
            mainDrive.put(pathToFile, await useDrive.get(useData.key))
          return sendTheData(signal, {status: 200, headers: {'Content-Length': `${useData.value.blob.byteLength}`, 'X-Link': `hyper://${mainDrive.key.toString('hex')}${pathToFile}`, 'Link': `<hyper://${mainDrive.key.toString('hex')}${pathToFile}>; rel="canonical"`}, body: []})
        } else {
          return sendTheData(signal, {status: 400, headers: {'X-Error': 'did not find any file'}, body: []})
        }
      } else {
        const useDrive = await checkForDrive(main.useHost)
        const useData = await Promise.race([
          useDrive.entry(main.usePath),
          new Promise((resolve, reject) => setTimeout(reject, useTimeOut))
        ])
        if (useData) {
          return sendTheData(signal, { status: 200, headers: { 'Content-Length': `${useData.value.blob.byteLength}`, 'X-Link': `hyper://${useDrive.key.toString('hex')}${useData.key}`, 'Link': `<hyper://${useDrive.key.toString('hex')}${useData.key}>; rel="canonical"` }, body: [] })
        } else if (path.extname(main.usePath)) {
          return sendTheData(signal, { status: 400, headers: {'X-Error': 'did not find any file'}, body: []})
        } else {
          let useNum = 0
          for await (const test of useDrive.list(main.usePath)){
            useNum = useNum + test.value.blob.byteLength
          }
          return sendTheData(signal, {status: 200, headers: {'Content-Length': `${useNum}`, 'X-Link': `hyper://${useDrive.key.toString('hex')}${main.usePath}`, 'Link': `<hyper://${useDrive.key.toString('hex')}${main.usePath}>; rel="canonical"`}, body: []})
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
      const useTimeOut = (reqHeaders.has('x-timer') && reqHeaders.get('x-timer') !== '0') || (searchParams.has('x-timer') && searchParams.get('x-timer') !== '0') ? Number(reqHeaders.get('x-timer') || searchParams.get('x-timer')) * 1000 : DEFAULT_TIMEOUT

      const mainReq = !reqHeaders.has('accept') || !reqHeaders.get('accept').includes('application/json')
      const mainRes = mainReq ? 'text/html; charset=utf-8' : 'application/json; charset=utf-8'
    
      const useDrive = await checkForDrive(main.useHost)
      const useData = await Promise.race([
        useDrive.entry(main.usePath),
        new Promise((resolve, reject) => setTimeout(reject, useTimeOut))
      ])
      if(useData){
        const isRanged = reqHeaders.has('Range') || reqHeaders.has('range')
        if(isRanged){
          const ranges = parseRange(useData.value.blob.byteLength, isRanged)
          // if (ranges && ranges.length && ranges.type === 'bytes') {
          if ((ranges !== -1 && ranges !== -2) && ranges.type === 'bytes') {
            const [{ start, end }] = ranges
            const length = (end - start + 1)
            return sendTheData(signal, {status: 206, headers: {'Content-Type': getMimeType(useData.key), 'X-Link': `hyper://${useDrive.key.toString('hex')}${useData.key}`, 'Link': `<hyper://${useDrive.key.toString('hex')}${useData.key}>; rel="canonical"`, 'Content-Length': `${length}`, 'Content-Range': `bytes ${start}-${end}/${useData.value.blob.byteLength}`}, body: useDrive.createReadStream(useData.key, {start, end})})
          } else {
            return sendTheData(signal, {status: 416, headers: {'Content-Type': mainRes, 'X-Link': `hyper://${useDrive.key.toString('hex')}${useData.key}`, 'Link': `<hyper://${useDrive.key.toString('hex')}${useData.key}>; rel="canonical"`, 'Content-Length': `${useData.value.blob.byteLength}`}, body: mainReq ? ['<html><head><title>range</title></head><body><div><p>malformed or unsatisfiable range</p></div></body></html>'] : [JSON.stringify('malformed or unsatisfiable range')]})
          }
        } else {
          return sendTheData(signal, {status: 200, headers: {'Content-Type': getMimeType(useData.key), 'X-Link': `hyper://${useDrive.key.toString('hex')}${useData.key}`, 'Link': `<hyper://${useDrive.key.toString('hex')}${useData.key}>; rel="canonical"`, 'Content-Length': `${useData.value.blob.byteLength}`}, body: useDrive.createReadStream(useData.key)})
        }
      } else if (path.extname(main.usePath)) {
        return sendTheData(signal, { status: 400, headers: { 'Content-Type': mainRes }, body: mainReq ? ['<html><head><title>range</title></head><body><div><p>did not find any file</p></div></body></html>'] : [JSON.stringify('did not find any file')] })
      } else {
        const arr = []
        for await (const test of useDrive.readdir(main.usePath)){
          const fold = path.join(main.usePath, test)
          const check = await useDrive.entry(fold)
          if(check){
            check.type = 'file'
            arr.push(check)
          } else {
            arr.push({key: fold.replace(/\\/g, "/"), type: 'folder'})
          }
        }
        return sendTheData(signal, {status: 200, headers: {'X-Link': `hyper://${useDrive.key.toString('hex')}${useData.key}`, 'Link': `<hyper://${useDrive.key.toString('hex')}${main.usePath}>; rel="canonical"`, 'Content-Type': mainRes}, body: mainReq ? [`<html><head><title>Fetch</title></head><body><div>${arr.length ? arr.map((data) => {return `<p><a href="hyper://${useDrive.key.toString('hex')}/${data}">${data}</a></p>`}) : '<p>there is no data</p>'}</div></body></html>`] : [JSON.stringify(arr)]})
      }
  }

  async function handlePost(request) {
    const { url, headers: reqHeaders, method, signal, body } = request

    if(signal){
      signal.addEventListener('abort', takeCareOfIt)
    }

      const { hostname, pathname, protocol, search, searchParams } = new URL(url)

      const main = formatReq(decodeURIComponent(hostname), decodeURIComponent(pathname))
      const useTimeOut = (reqHeaders.has('x-timer') && reqHeaders.get('x-timer') !== '0') || (searchParams.has('x-timer') && searchParams.get('x-timer') !== '0') ? Number(reqHeaders.get('x-timer') || searchParams.get('x-timer')) * 1000 : DEFAULT_TIMEOUT

      const mainReq = !reqHeaders.has('accept') || !reqHeaders.get('accept').includes('application/json')
      const mainRes = mainReq ? 'text/html; charset=utf-8' : 'application/json; charset=utf-8'
    
      const useDrive = await checkForDrive(main.useHost)
      const hasOpt = reqHeaders.has('x-opt') || searchParams.has('x-opt')
      const useOpt = hasOpt ? JSON.parse(reqHeaders.get('x-opt') || decodeURIComponent(searchParams.get('x-opt'))) : {}
      const saved = reqHeaders.has('content-type') && reqHeaders.get('content-type').includes('multipart/form-data') ? await saveFormData(useDrive, main, handleFormData(await request.formData()), useOpt, useTimeOut) : await saveFileData(useDrive, main, body, useOpt, useTimeOut)
      return sendTheData(signal, {status: 200, headers: {'Content-Type': mainRes}, body: mainReq ? [`<html><head><title>Fetch</title></head><body><div>${JSON.stringify(saved)}</div></body></html>`] : [JSON.stringify(saved)]})
  }

  async function handleDelete(request) {
    const { url, headers: reqHeaders, method, signal, body } = request

    if(signal){
      signal.addEventListener('abort', takeCareOfIt)
    }

      const { hostname, pathname, protocol, search, searchParams } = new URL(url)

      const main = formatReq(decodeURIComponent(hostname), decodeURIComponent(pathname))
      const useTimeOut = (reqHeaders.has('x-timer') && reqHeaders.get('x-timer') !== '0') || (searchParams.has('x-timer') && searchParams.get('x-timer') !== '0') ? Number(reqHeaders.get('x-timer') || searchParams.get('x-timer')) * 1000 : DEFAULT_TIMEOUT

      const mainReq = !reqHeaders.has('accept') || !reqHeaders.get('accept').includes('application/json')
      const mainRes = mainReq ? 'text/html; charset=utf-8' : 'application/json; charset=utf-8'
    
      const useDrive = await checkForDrive(main.useHost)
      const useData = await Promise.race([
        useDrive.entry(main.usePath),
        new Promise((resolve, reject) => setTimeout(reject, useTimeOut))
      ])
      if(useData){
        await useDrive.del(useData.key)
        return sendTheData(signal, {status: 200, headers: {'Content-Type': mainRes, 'Link': `<hyper://${useDrive.key.toString('hex')}${useData.key}>; rel="canonical"`, 'Content-Length': `${useData.value.blob.byteLength}`}, body: mainReq ? [`<html><head><title>Fetch</title></head><body><div>${useData}</div></body></html>`] : [JSON.stringify(useData)]})
      } else {
        const useArr = []
        let useNum = 0
        for await (const test of useDrive.list(main.usePath)){
          useNum = useNum + test.value.blob.byteLength
          await useDrive.del(test.key)
          useArr.push(test)
        }
        return sendTheData(signal, {status: 200, headers: {'Content-Type': mainRes, 'Link': `<hyper://${useDrive.key.toString('hex')}${main.usePath}>; rel="canonical"`, 'Content-Length': `${useNum}`}, body: mainReq ? [`<html><head><title>Fetch</title></head><body><div>${useArr}</div></body></html>`] : [JSON.stringify(useArr)]})
      }
  }

  router.head('hyper://*/**', handleHead)
  router.get('hyper://*/**', handleGet)
  router.post('hyper://*/**', handlePost)
  router.delete('hyper://*/**', handleDelete)

  fetch.close = async () => {return await app.close()}

  return fetch
}