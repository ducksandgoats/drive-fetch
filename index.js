module.exports = async function makeHyperFetch (opts = {}) {
  const {makeFetch} = await import('make-fetch')
  const mime = require('mime/lite')
  const parseRange = require('range-parser')
  const { Readable } = require('stream')
  const Busboy = require('busboy')
  const path = require('path')

  const DEFAULT_OPTS = {}
  const finalOpts = { ...DEFAULT_OPTS, ...opts }
  const app = await (async (finalOpts) => {if(finalOpts.sdk){return finalOpts.sdk}else{const SDK = await import('hyper-sdk');const sdk = await SDK.create(finalOpts);return sdk;}})(finalOpts)
  const DEFAULT_TIMEOUT = 30000
  const hostType = '_'
  const SUPPORTED_METHODS = ['GET', 'HEAD', 'POST', 'DELETE']

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

  async function saveFileData(drive, main, body, useOpt, useTimeOut){
    return await Promise.race([
      new Promise((resolve, reject) => {
        const source = Readable.from(body)
        const destination = drive.createWriteStream(main.usePath, useOpt)
        source.pipe(destination)
        source.once('error', reject)
        destination.once('error', reject)
        source.once('close', () => {
          console.log('close')
        })
        destination.once('close', () => {
          resolve({})
        })
      }),
      new Promise((resolve, reject) => setTimeout(reject, useTimeOut))
    ])
  }

  async function saveFormData(drive, mid, content, useHeaders, useOpts, timeout) {
    const {savePath, saveIter} = await new Promise((resolve, reject) => {
      const savePath = []
      const saveIter = []
      const busboy = Busboy({ headers: useHeaders })

      function handleOff(){
        busboy.off('error', handleError)
        busboy.off('finish', handleFinish)
        busboy.off('file', handleFiles)
      }
      function handleFinish(){
        handleOff()
        resolve({savePath, saveIter})
      }
      function handleError(error){
        handleOff()
        reject(error)
      }
      function handleFiles(fieldName, fileData, info){
        const usePath = path.join(mid.usePath, info.filename).replace(/\\/g, "/")
        savePath.push(usePath)
        saveIter.push(
          Promise.race([
            new Promise((resolve, reject) => {
              const source = Readable.from(fileData)
              const destination = drive.createWriteStream(usePath, useOpts)
              source.pipe(destination)
              source.once('error', reject)
              destination.once('error', reject)
              source.once('end', resolve)
            }),
            new Promise((resolve, reject) => setTimeout(reject, timeout))
          ])
        )
      }
      busboy.on('error', handleError)
      busboy.on('finish', handleFinish)

      busboy.on('file', handleFiles)
  
      Readable.from(content).pipe(busboy)
    })

    // await Promise.all(saveIter)
    for(const test of saveIter){
      await test
    }
    return savePath
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

  const fetch = makeFetch(async (request) => {

    const { url, headers: reqHeaders, method, signal, body } = request

    if(signal){
      signal.addEventListener('abort', takeCareOfIt)
    }

    try {
      const { hostname, pathname, protocol, search, searchParams } = new URL(url)

      if (protocol !== 'hyper:') {
        return sendTheData(signal, {statusCode: 409, headers: {}, data: ['wrong protocol'] })
      } else if (!method || !SUPPORTED_METHODS.includes(method)) {
        return sendTheData(signal, {statusCode: 409, headers: {}, data: ['something wrong with method'] })
      } else if (hostname.length !== 64 || hostname !== hostType) {
        return sendTheData(signal, {statusCode: 409, headers: {}, data: ['something wrong with hostname'] })
      }

      const main = formatReq(decodeURIComponent(hostname), decodeURIComponent(pathname))
      const useTimeOut = (reqHeaders['x-timer'] && reqHeaders['x-timer'] !== '0') || (searchParams.has('x-timer') && searchParams.get('x-timer') !== '0') ? Number(reqHeaders['x-timer'] || searchParams.get('x-timer')) * 1000 : DEFAULT_TIMEOUT

      const mainReq = !reqHeaders.accept || !reqHeaders.accept.includes('application/json')
      const mainRes = mainReq ? 'text/html; charset=utf-8' : 'application/json; charset=utf-8'

      if(method === 'HEAD'){
        try {
          const useDrive = await checkForDrive(main.useHost)
          const useData = await Promise.race([
            useDrive.entry(main.usePath),
            new Promise((resolve, reject) => setTimeout(reject, useTimeOut))
          ])
          if(useData){
            return sendTheData(signal, {statusCode: 200, headers: {'Link': `<hyper://${useDrive.key.toString('hex')}${useData.key}>; rel="canonical"`}, data: []})
          } else {
            return sendTheData(signal, {statusCode: 400, headers: {'Link': `<hyper://${useDrive.key.toString('hex')}${main.usePath}>; rel="canonical"`}, data: []})
          }
        } catch (error) {
          return sendTheData(signal, {statusCode: 400, headers: {'X-Issue': error.name}, data: []})
        }
      } else if(method === 'GET'){
    try {
      const useDrive = await checkForDrive(main.useHost)
      const useData = await Promise.race([
        useDrive.entry(main.usePath),
        new Promise((resolve, reject) => setTimeout(reject, useTimeOut))
      ])
      if(useData){
        const isRanged = reqHeaders.Range || reqHeaders.range
        if(isRanged){
          const ranges = parseRange(mainData.size, isRanged)
          if (ranges && ranges.length && ranges.type === 'bytes') {
            const [{ start, end }] = ranges
            const length = (end - start + 1)
            return sendTheData(signal, {statusCode: 206, headers: {'Content-Type': getMimeType(useData.key), 'Link': `<hyper://${useDrive.key.toString('hex')}${useData.key}>; rel="canonical"`, 'Content-Length': `${length}`, 'Content-Range': `bytes ${start}-${end}/${useData.value.blob.byteLength}`}, data: useDrive.createReadStream(useData.key, {start, end})})
          } else {
            return sendTheData(signal, {statusCode: 200, headers: {'Content-Type': getMimeType(useData.key), 'Link': `<hyper://${useDrive.key.toString('hex')}${useData.key}>; rel="canonical"`, 'Content-Length': `${useData.value.blob.byteLength}`}, data: useDrive.createReadStream(useData.key)})
          }
        } else {
          return sendTheData(signal, {statusCode: 200, headers: {'Content-Type': getMimeType(useData.key), 'Link': `<hyper://${useDrive.key.toString('hex')}${useData.key}>; rel="canonical"`, 'Content-Length': `${useData.value.blob.byteLength}`}, data: useDrive.createReadStream(useData.key)})
        }
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
        return sendTheData(signal, {statusCode: 200, headers: {'Link': `<hyper://${useDrive.key.toString('hex')}${main.usePath}>; rel="canonical"`, 'Content-Type': mainRes}, data: mainReq ? [`<html><head><title>Fetch</title></head><body><div>${JSON.stringify(arr)}</div></body></html>`] : [JSON.stringify(arr)]})
      }
    } catch (error) {
      return sendTheData(signal, {statusCode: 400, headers: {'Content-Type': mainRes, 'X-Issue': error.name}, data: mainReq ? [`<html><head><title>${error.name}</title></head><body><div><p>${error.name}</p></div></body></html>`] : [JSON.stringify(error.name)]})
    }
      } else if(method === 'POST'){
        try {
          const useDrive = await checkForDrive(main.useHost)
          const hasOpt = reqHeaders['x-opt'] || searchParams.has('x-opt')
          const useOpt = hasOpt ? JSON.parse(reqHeaders['x-opt'] || decodeURIComponent(searchParams.get('x-opt'))) : {}
          const mainData = await (async () => {
            if(reqHeaders['content-type'] && reqHeaders['content-type'].includes('multipart/form-data')){
              return await iterFiles(useDrive, await saveFormData(useDrive, main, body, reqHeaders, useOpt, useTimeOut), useTimeOut, main)
            } else {
              return await iterFile(useDrive, await saveFileData(useDrive, main, body, useOpt, useTimeOut), main, useTimeOut)
            }
          })()
          return sendTheData(signal, {statusCode: 200, headers: {'Content-Type': mainRes}, data: mainReq ? [`<html><head><title>Fetch</title></head><body><div>${JSON.stringify(mainData)}</div></body></html>`] : [JSON.stringify(mainData)]})
        } catch (error) {
          return sendTheData(signal, {statusCode: 400, headers: {'Content-Type': mainRes, 'X-Issue': error.name}, data: mainReq ? [`<html><head><title>${error.name}</title></head><body><div><p>${error.name}</p></div></body></html>`] : [JSON.stringify(error.name)]})
        }
      } else if(method === 'DELETE'){
        try {
          const useDrive = await checkForDrive(main.useHost)
          const useData = await Promise.race([
            useDrive.entry(main.usePath),
            new Promise((resolve, reject) => setTimeout(reject, useTimeOut))
          ])
          if(useData){
            await useDrive.del(useData.key)
            return sendTheData(signal, {statusCode: 200, headers: {'Content-Type': mainRes, 'Link': `<hyper://${useDrive.key.toString('hex')}${useData.key}>; rel="canonical"`, 'Content-Length': `${useData.value.blob.byteLength}`}, data: mainReq ? [`<html><head><title>Fetch</title></head><body><div>${useData}</div></body></html>`] : [JSON.stringify(useData)]})
          } else {
            const useArr = []
            let useNum = 0
            for await (const test of useDrive.list(main.usePath)){
              useNum = useNum + test.value.blob.byteLength
              await useDrive.del(test.key)
              useArr.push(test)
            }
            return sendTheData(signal, {statusCode: 200, headers: {'Content-Type': mainRes, 'Link': `<hyper://${useDrive.key.toString('hex')}${main.usePath}>; rel="canonical"`, 'Content-Length': `${useNum}`}, data: mainReq ? [`<html><head><title>Fetch</title></head><body><div>${useArr}</div></body></html>`] : [JSON.stringify(useArr)]})
          }
        } catch (error) {
          return sendTheData(signal, {statusCode: 400, headers: {'Content-Type': mainRes, 'X-Issue': error.name}, data: mainReq ? [`<html><head><title>${error.name}</title></head><body><div><p>${error.name}</p></div></body></html>`] : [JSON.stringify(error.name)]})
        }
      } else {
        return sendTheData(signal, {statusCode: 400, headers: {'Content-Type': mainRes}, data: mainReq ? [`<html><head><title>Fetch</title></head><body><div>method is not supported</div></body></html>`] : [JSON.stringify('method is not supported')]})
      }
    } catch (error) {
      const mainReq = !reqHeaders.accept || !reqHeaders.accept.includes('application/json')
      const mainRes = mainReq ? 'text/html; charset=utf-8' : 'application/json; charset=utf-8'
      return sendTheData(signal, {statusCode: 500, headers: {'Content-Type': mainRes}, data: mainReq ? [`<html><head><title>${error.name}</title></head><body><div><p>${error.stack}</p></div></body></html>`] : [JSON.stringify(error.stack)]})
    }
  })

  fetch.close = async () => {return await app.close()}

  return fetch
}