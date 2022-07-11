const mime = require('mime/lite')
const parseRange = require('range-parser')
const { Readable } = require('stream')
const makeFetch = require('make-fetch')
const Busboy = require('busboy')
const path = require('path')

module.exports = async function makeHyperFetch (opts = {}) {
  const DEFAULT_OPTS = {}
  const finalOpts = { ...DEFAULT_OPTS, ...opts }
  const app = await (async (finalOpts) => {if(finalOpts.sdk){return finalOpts.sdk}else{const SDK = require('hyper-sdk');const sdk = await SDK(finalOpts);await sdk.Hyperdrive('id').ready();return sdk;}})(finalOpts)
  // await app.Hyperdrive('id').ready()
  const DEFAULT_TIMEOUT = 30000
  const encodeType = 'hex'
  const hostType = '_'
  const SUPPORTED_METHODS = ['GET', 'HEAD', 'PUT', 'DELETE']

  function formatReq(hostname, pathname){

    const useData = {}
    if(hostname === hostType){
      useData.useHost = 'id'
    } else {
      useData.useHost = hostname
    }
    useData.usePath = decodeURIComponent(pathname)
    return useData
  }

  function makeTimeOut(data, timeout, res, name = null){
    if(name){
      data.name = name
    }
    return new Promise((resolve, reject) => {setTimeout(() => {if(res){resolve(data)}else{reject(data)}}, timeout)})
  }

  async function saveFormData (mid, content, useHeaders, useOpts, timeout) {
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
              const destination = app.Hyperdrive(mid.useHost).createWriteStream(usePath, useOpts)
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

    await Promise.all(saveIter)
    return savePath
  }

  async function iterFiles(data, timer, main){
    const prop = app.Hyperdrive(main.useHost).key.toString('hex')
    const result = []
    for(const i of data){
      try {
        let useData = await Promise.race([
          app.Hyperdrive(main.useHost).stat(i),
          new Promise((resolve, reject) => setTimeout(reject, timer))
        ])
        useData = Array.isArray(useData) ? useData[0] : useData
        useData.pid  = prop
        useData.file = i
        useData.host = 'hyper://' + useData.pid
        useData.link = path.join(useData.host, useData.file).replace(/\\/g, "/")
        result.push(useData)
      } catch (error) {
        console.error(typeof(error))
        let useData = {}
        useData.pid  = prop
        useData.file = i
        useData.host = 'hyper://' + useData.pid
        useData.link = path.join(useData.host, useData.file).replace(/\\/g, "/")
        result.push(useData)
      }
    }
    return result
  }

  async function iterFile(main, timer){
    const prop = app.Hyperdrive(main.useHost).key.toString('hex')
    const result = []
    try {
      let useData = await Promise.race([
        app.Hyperdrive(main.useHost).stat(main.usePath),
        new Promise((resolve, reject) => setTimeout(reject, timer))
      ])
      useData = Array.isArray(useData) ? useData[0] : useData
      useData.pid  = prop
      useData.file = main.usePath
      useData.link = `hyper://${path.join(useData.pid, useData.file).replace(/\\/g, "/")}`
      result.push(useData)
    } catch (error) {
      console.error(error)
      let useData = {}
      useData.pid  = prop
      useData.file = main.usePath
      useData.link = `hyper://${path.join(useData.pid, useData.file).replace(/\\/g, "/")}`
      result.push(useData)
    }
    return result
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

    try {
      const { hostname, pathname, protocol, search, searchParams } = new URL(url)
      const mainHostname = hostname && hostname.startsWith(encodeType) ? Buffer.from(hostname.slice(encodeType.length), 'hex').toString('utf-8') : hostname

      if (protocol !== 'hyper:') {
        return { statusCode: 409, headers: {}, data: ['wrong protocol'] }
      } else if (!method || !SUPPORTED_METHODS.includes(method)) {
        return { statusCode: 409, headers: {}, data: ['something wrong with method'] }
      } else if (!mainHostname) {
        return { statusCode: 409, headers: {}, data: ['something wrong with hostname'] }
      }

      const main = formatReq(decodeURIComponent(mainHostname), decodeURIComponent(pathname))
      const useTimeOut = (reqHeaders['x-timer'] && reqHeaders['x-timer'] !== '0') || (searchParams.has('x-timer') && searchParams.get('x-timer') !== '0') ? Number(reqHeaders['x-timer'] || searchParams.get('x-timer')) * 1000 : DEFAULT_TIMEOUT

      const mainReq = !reqHeaders.accept || !reqHeaders.accept.includes('application/json')
      const mainRes = mainReq ? 'text/html; charset=utf-8' : 'application/json; charset=utf-8'

      if(method === 'HEAD'){
        try {
          if(reqHeaders['x-mount'] && reqHeaders['x-mount'] === 'true'){
            const mainData = await Promise.race([
              makeTimeOut(new Error('this was timed out'), useTimeOut, false, 'TimeoutError'),
              app.Hyperdrive('id').mount(decodeURIComponent(main.usePath), main.useHost)
            ])
            return {statusCode: 200, headers: {'X-Data': `${JSON.stringify(mainData)}`, 'Link': `<hyper://${app.Hyperdrive('id').key.toString('hex')}${main.usePath}>; rel="canonical"`}, data: []}
          } else if(reqHeaders['x-unmount'] && reqHeaders['x-unmount'] === 'true'){
            const mainData = await Promise.race([
              makeTimeOut(new Error('this was timed out'), useTimeOut, false, 'TimeoutError'),
              app.Hyperdrive('id').unmount(decodeURIComponent(main.usePath))
            ])
            return {statusCode: 200, headers: {'X-Data': `${JSON.stringify(mainData)}`, 'Link': `<hyper://${app.Hyperdrive('id').key.toString('hex')}${main.usePath}>; rel="canonical"`}, data: []}
          } else {
            const useData = await Promise.race([
              makeTimeOut(new Error('this was timed out'), useTimeOut, false, 'TimeoutError'),
              app.Hyperdrive(main.useHost).stat(decodeURIComponent(main.usePath))
            ])
            const mainData = Array.isArray(useData) ? useData[0] : useData
            return {statusCode: 200, headers: {'Link': `<hyper://${main.useHost}${main.usePath}>; rel="canonical"`, 'Content-Length': `${mainData.size}`}, data: []}
          }
        } catch (error) {
          return {statusCode: 400, headers: {'X-Issue': error.name}, data: []}
        }
      } else if(method === 'GET'){
        let mainData = null
        try {
          mainData = await Promise.race([
            makeTimeOut(new Error('this was timed out'), useTimeOut, false, 'TimeoutError'),
            app.Hyperdrive(main.useHost).stat(main.usePath)
          ])
          mainData = Array.isArray(mainData) ? mainData[0] : mainData
        } catch (error) {
          return {statusCode: 400, headers: {'Content-Type': mainRes, 'X-Issue': error.message}, data: mainReq ? [`<html><head><title>Fetch</title></head><body><div>${error.stack}</div></body></html>`] : [JSON.stringify(error.stack)]}
        }
        if(mainData.isDirectory()){
          mainData = await app.Hyperdrive(main.useHost).readdir(main.usePath)
          return {statusCode: 200, headers: {'Content-Type': mainRes, 'Link': `<hyper://${main.useHost}${main.usePath}>; rel="canonical"`, 'Content-Length': `${mainData.size}`}, data: mainReq ? [`<html><head><title>Fetch</title></head><body><div>${JSON.stringify(mainData)}</div></body></html>`] : [JSON.stringify(mainData)]}
        } else if(mainData.isFile()){
          const isRanged = reqHeaders.Range || reqHeaders.range
            if(isRanged){
              const ranges = parseRange(mainData.size, isRanged)
              if (ranges && ranges.length && ranges.type === 'bytes') {
                const [{ start, end }] = ranges
                const length = (end - start + 1)
                return {statusCode: 206, headers: {'Content-Type': getMimeType(main.usePath), 'Link': `<hyper://${main.useHost !== hostType ? main.useHost : app.Hyperdrive('id').key.toString('hex')}${main.usePath}>; rel="canonical"`, 'Content-Length': `${length}`, 'Content-Range': `bytes ${start}-${end}/${mainData.size}`}, data: app.Hyperdrive(main.useHost).createReadStream(main.usePath, {start, end})}
              } else {
                return {statusCode: 200, headers: {'Content-Type': getMimeType(main.usePath), 'Link': `<hyper://${main.useHost !== hostType ? main.useHost : app.Hyperdrive('id').key.toString('hex')}${main.usePath}>; rel="canonical"`, 'Content-Length': `${mainData.size}`}, data: app.Hyperdrive(main.useHost).createReadStream(main.usePath)}
              }
            } else {
              return {statusCode: 200, headers: {'Content-Type': getMimeType(main.usePath), 'Link': `<hyper://${main.useHost !== hostType ? main.useHost : app.Hyperdrive('id').key.toString('hex')}${main.usePath}>; rel="canonical"`, 'Content-Length': `${mainData.size}`}, data: app.Hyperdrive(main.useHost).createReadStream(main.usePath)}
            }
        } else {
          throw new Error('not a directory or file')
        }
      } else if(method === 'PUT'){
        let mainData = null
        try {
          const hasOpt = reqHeaders['x-opt'] || searchParams.has('x-opt')
          const useOpt = hasOpt ? JSON.parse(reqHeaders['x-opt'] || decodeURIComponent(searchParams.get('x-opt'))) : {}
          if(reqHeaders['content-type'] && reqHeaders['content-type'].includes('multipart/form-data')){
            mainData = await iterFiles(await saveFormData(main, body, reqHeaders, useOpt, useTimeOut), useTimeOut, main)
          } else {
            await Promise.race([
              new Promise((resolve, reject) => {
                const source = Readable.from(body)
                const destination = app.Hyperdrive(main.useHost).createWriteStream(main.usePath, useOpt)
                source.pipe(destination)
                source.once('error', reject)
                destination.once('error', reject)
                source.once('end', resolve)
              }),
              new Promise((resolve, reject) => setTimeout(reject, useTimeOut))
            ])
            mainData = await iterFile(main, useTimeOut)
          }
        } catch (error) {
          return {statusCode: 400, headers: {'Content-Type': mainRes, 'X-Issue': error.name}, data: mainReq ? [`<html><head><title>Fetch</title></head><body><div>${error.message}</div></body></html>`] : [JSON.stringify(error.message)]}
        }
        return {statusCode: 200, headers: {'Content-Type': mainRes}, data: mainReq ? [`<html><head><title>Fetch</title></head><body><div>${JSON.stringify(mainData)}</div></body></html>`] : [JSON.stringify(mainData)]}
      } else if(method === 'DELETE'){
        let mainData = null
        try {
          mainData = await Promise.race([
            makeTimeOut(new Error('this was timed out'), useTimeOut, false, 'TimeoutError'),
            app.Hyperdrive(main.useHost).stat(main.usePath)
          ])
        } catch (error) {
          return {statusCode: 400, headers: {'Content-Type': mainRes, 'X-Issue': error.name}, data: mainReq ? [`<html><head><title>Fetch</title></head><body><div>${error.message}</div></body></html>`] : [JSON.stringify(error.message)]}
        }
        mainData.pid = app.Hyperdrive(main.useHost).key
        mainData.path = main.usePath
        mainData.link = `hyper://${path.join(mainData.pid, mainData.path).replace(/\\/g, "/")}`
        if(mainData.isDirectory()){
          const getDir = await app.Hyperdrive(main.useHost).readdir(main.usePath, {recursive: true})
          if(getDir.length){
            for(const i of getDir){
              await app.Hyperdrive(main.useHost).unlink(path.join(main.usePath, i).replace(/\\/g, "/"))
            }
          }
          await app.Hyperdrive(main.useHost).rmdir(main.usePath)
        } else if(mainData.isFile()){
          await app.Hyperdrive(main.useHost).unlink(main.usePath)
        } else {
          throw new Error('not a directory or file')
        }
        return {statusCode: 200, headers: {'Content-Type': mainRes}, data: mainReq ? [`<html><head><title>Fetch</title></head><body><div>${JSON.stringify(mainData)}</div></body></html>`] : [JSON.stringify(mainData)]}
      } else {
        return {statusCode: 400, headers: {'Content-Type': mainRes}, data: mainReq ? [`<html><head><title>Fetch</title></head><body><div>method is not supported</div></body></html>`] : [JSON.stringify('method is not supported')]}
      }
    } catch (error) {
      const mainReq = !reqHeaders.accept || !reqHeaders.accept.includes('application/json')
      const mainRes = mainReq ? 'text/html; charset=utf-8' : 'application/json; charset=utf-8'
      return {statusCode: 500, headers: {'Content-Type': mainRes}, data: mainReq ? [`<html><head><title>${error.name}</title></head><body><div><p>${error.stack}</p></div></body></html>`] : [JSON.stringify(error.stack)]}
    }
  })

  fetch.close = async () => {return await app.close()}

  return fetch
}