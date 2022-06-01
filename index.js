const mime = require('mime/lite')
const SDK = require('hyper-sdk')
const parseRange = require('range-parser')
const { Readable } = require('stream')
const makeFetch = require('make-fetch')
const Busboy = require('busboy')
const path = require('path')

module.exports = async function makeHyperFetch (opts = {}) {
  const DEFAULT_OPTS = {}
  const finalOpts = { ...DEFAULT_OPTS, ...opts }
  const app = await (async (finalOpts) => {if(finalOpts.sdk){return finalOpts.sdk}else{const sdk = await SDK(finalOpts);await sdk.Hyperdrive('fetch').ready();return sdk;}})(finalOpts)
  // await app.Hyperdrive('fetch').ready()
  const DEFAULT_TIMEOUT = 30000
  const encodeType = 'hex'
  const hostType = '_'
  const SUPPORTED_METHODS = ['GET', 'HEAD', 'PUT', 'DELETE']

  function formatReq(hostname, pathname){
    const useData = {}
    if(hostname === hostType){
      useData.useHost = 'fetch'
    } else {
      useData.useHost = hostname
    }
    const pathNameArr = pathname.split('/').filter(Boolean)
    if(pathNameArr.length){
      if(pathNameArr[pathNameArr.length - 1].includes('.')){
        useData.usePath = pathname
      } else {
        useData.usePath = pathname + '/'
      }
    } else {
      useData.usePath = pathname
    }
    return useData
  }

  function useTimeOut(data, timeout, res, name = null){
    if(name){
      data.name = name
    }
    return new Promise((resolve, reject) => {setTimeout(() => {if(res){resolve(data)}else{reject(data)}}, timeout)})
  }

  async function saveFormData (mid, content, useHeaders, useOpts) {
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
        const usePath = mid.usePath + info.filename
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
            new Promise((resolve, reject) => setTimeout(reject, useOpts.timeout))
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
        useData.link = 'hyper://' + useData.pid + useData.file
        result.push(useData)
      } catch (error) {
        console.error(typeof(error))
        let useData = {}
        useData.pid  = prop
        useData.file = i
        useData.link = 'hyper://' + useData.pid + useData.file
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
      useData.link = 'hyper://' + useData.pid + useData.file
      result.push(useData)
    } catch (error) {
      console.error(error)
      let useData = {}
      useData.pid  = prop
      useData.file = main.usePath
      useData.link = 'hyper://' + useData.pid + useData.file
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
      const { hostname, pathname, protocol, searchParams } = new URL(url)
      const mainHostname = hostname && hostname.startsWith(encodeType) ? Buffer.from(hostname.slice(encodeType.length), 'hex').toString('utf-8') : hostname

      if (protocol !== 'hyper:') {
        return { statusCode: 409, headers: {}, data: ['wrong protocol'] }
      } else if (!method || !SUPPORTED_METHODS.includes(method)) {
        return { statusCode: 409, headers: {}, data: ['something wrong with method'] }
      } else if (!mainHostname) {
        return { statusCode: 409, headers: {}, data: ['something wrong with hostname'] }
      }

      const main = formatReq(mainHostname, pathname)

      if(method === 'HEAD'){
        let mainData = null
        try {
          mainData = await Promise.race([
            useTimeOut(new Error('this was timed out'), reqHeaders['x-timer'] && reqHeaders['x-timer'] !== '0' ? Number(reqHeaders['x-timer']) * 1000 : DEFAULT_TIMEOUT, false, 'TimeoutError'),
            app.Hyperdrive(main.useHost).stat(main.usePath)
          ])
          mainData = Array.isArray(mainData) ? mainData[0] : mainData
        } catch (error) {
          return {statusCode: 400, headers: {'X-Issue': error.message}, data: []}
        }
        return {statusCode: 200, headers: {'Link': `<hyper://${main.useHost}${main.usePath}>; rel="canonical"`, 'Content-Length': `${mainData.size}`}, data: []}
      } else if(method === 'GET'){
        let mainData = null
        try {
          mainData = await Promise.race([
            useTimeOut(new Error('this was timed out'), reqHeaders['x-timer'] && reqHeaders['x-timer'] !== '0' ? Number(reqHeaders['x-timer']) * 1000 : DEFAULT_TIMEOUT, false, 'TimeoutError'),
            app.Hyperdrive(main.useHost).stat(main.usePath)
          ])
          mainData = Array.isArray(mainData) ? mainData[0] : mainData
        } catch (error) {
          return {statusCode: 400, headers: {'X-Issue': error.message}, data: [error.stack]}
        }
        if(mainData.isDirectory()){
          mainData = await app.Hyperdrive(main.useHost).readdir(main.usePath)
          if(!reqHeaders['accept'] || !reqHeaders['accept'].includes('text/html') || !reqHeaders['accept'].includes('application/json')){
            let useData = ''
            mainData.forEach(data => {
              useData += `${data}\n`
            })
            return {statusCode: 200, headers: {'Content-Type': 'text/plain; charset=utf-8', 'Link': `<hyper://${main.useHost}${main.usePath}>; rel="canonical"`, 'Content-Length': `${mainData.size}`}, data: [useData]}
          } else if(reqHeaders['accept'].includes('text/html')){
            return {statusCode: 200, headers: {'Content-Type': 'text/html; charset=utf-8', 'Link': `<hyper://${main.useHost}${main.usePath}>; rel="canonical"`, 'Content-Length': `${mainData.size}`}, data: [`<html><head><title>Fetch</title></head><body><div>${JSON.stringify(mainData)}</div></body></html>`]}
          } else if(reqHeaders['accept'].includes('application/json')){
            return {statusCode: 200, headers: {'Content-Type': 'application/json; charset=utf-8', 'Link': `<hyper://${main.useHost}${main.usePath}>; rel="canonical"`, 'Content-Length': `${mainData.size}`}, data: [JSON.stringify(mainData)]}
          }
        } else if(mainData.isFile()){
            if(reqHeaders.Range || reqHeaders.range){
              const ranges = parseRange(size, isRanged)
              if (ranges && ranges.length && ranges.type === 'bytes') {
                const [{ start, end }] = ranges
                const length = (end - start + 1)
                return {statusCode: 206, headers: {'Content-Type': getMimeType(main.usePath), 'Link': `<hyper://${main.useHost !== hostType ? main.useHost : app.Hyperdrive('fetch').key.toString('hex')}${main.usePath}>; rel="canonical"`, 'Content-Length': `${length}`, 'Content-Range': `bytes ${start}-${end}/${mainData.size}`}, data: app.Hyperdrive(main.useHost).createReadStream(main.usePath, {start, end})}
              } else {
                return {statusCode: 200, headers: {'Content-Type': getMimeType(main.usePath), 'Link': `<hyper://${main.useHost !== hostType ? main.useHost : app.Hyperdrive('fetch').key.toString('hex')}${main.usePath}>; rel="canonical"`, 'Content-Length': `${mainData.size}`}, data: app.Hyperdrive(main.useHost).createReadStream(main.usePath)}
              }
            } else {
              return {statusCode: 200, headers: {'Content-Type': getMimeType(main.usePath), 'Link': `<hyper://${main.useHost !== hostType ? main.useHost : app.Hyperdrive('fetch').key.toString('hex')}${main.usePath}>; rel="canonical"`, 'Content-Length': `${mainData.size}`}, data: app.Hyperdrive(main.useHost).createReadStream(main.usePath)}
            }
        } else {
          throw new Error('not a directory or file')
        }
      } else if(method === 'PUT'){
        let mainData = null
        try {
          if(reqHeaders['content-type'] && reqHeaders['content-type'].includes('multipart/form-data')){
            mainData = await saveFormData(main, body, reqHeaders, reqHeaders['x-opt'] ? {...JSON.parse(reqHeaders['x-opt']), timeout: reqHeaders['x-timer'] && reqHeaders['x-timer'] !== '0' ? Number(reqHeaders['x-timer']) * 1000 : DEFAULT_TIMEOUT} : {timeout: reqHeaders['x-timer'] && reqHeaders['x-timer'] !== '0' ? Number(reqHeaders['x-timer']) * 1000 : DEFAULT_TIMEOUT})
            mainData = await iterFiles(mainData, reqHeaders['x-timer'] && reqHeaders['x-timer'] !== '0' ? Number(reqHeaders['x-timer']) * 1000 : DEFAULT_TIMEOUT, main)
          } else {
            await Promise.race([
              new Promise((resolve, reject) => {
                const source = Readable.from(body)
                const destination = app.Hyperdrive(main.useHost).createWriteStream(main.usePath, reqHeaders['x-opt'] ? {...JSON.parse(reqHeaders['x-opt']), timeout: reqHeaders['x-timer'] && reqHeaders['x-timer'] !== '0' ? Number(reqHeaders['x-timer']) * 1000 : DEFAULT_TIMEOUT} : {})
                source.pipe(destination)
                source.once('error', reject)
                destination.once('error', reject)
                source.once('end', resolve)
              }),
              new Promise((resolve, reject) => setTimeout(reject, DEFAULT_TIMEOUT))
            ])
            mainData = await iterFile(main, DEFAULT_TIMEOUT)
          }
        } catch (error) {
          if(!reqHeaders['accept'] || !reqHeaders['accept'].includes('text/html') || !reqHeaders['accept'].includes('application/json')){
            return {statusCode: 400, headers: {'Content-Type': 'text/plain; charset=utf-8', 'X-Issue': error.name}, data: [error.message]}
          } else if(reqHeaders['accept'].includes('text/html')){
            return {statusCode: 400, headers: {'Content-Type': 'text/html; charset=utf-8', 'X-Issue': error.name}, data: [`<html><head><title>Fetch</title></head><body><div>${error.message}</div></body></html>`]}
          } else if(reqHeaders['accept'].includes('application/json')){
            return {statusCode: 400, headers: {'Content-Type': 'application/json; charset=utf-8', 'X-Issue': error.name}, data: [JSON.stringify(error.message)]}
          }
        }
        if((!reqHeaders['accept']) || (!reqHeaders['accept'].includes('text/html') && !reqHeaders['accept'].includes('application/json'))){
          let useData = ''
          mainData.forEach(data => {
            for(const prop in data){
              useData += `${prop}: ${data[prop]}\n`
            }
            useData += '\n\n\n'
          })
          return {statusCode: 200, headers: {'Content-Type': 'text/plain; charset=utf-8'}, data: [useData]}
        } else if(reqHeaders['accept'].includes('text/html')){
          return {statusCode: 200, headers: {'Content-Type': 'text/html; charset=utf-8'}, data: [`<html><head><title>Fetch</title></head><body><div>${JSON.stringify(mainData)}</div></body></html>`]}
        } else if(reqHeaders['accept'].includes('application/json')){
          return {statusCode: 200, headers: {'Content-Type': 'application/json; charset=utf-8'}, data: [JSON.stringify(mainData)]}
        }
      } else if(method === 'DELETE'){
        let mainData = null
        try {
          mainData = await Promise.race([
            useTimeOut(new Error('this was timed out'), reqHeaders['x-timer'] && reqHeaders['x-timer'] !== '0' ? Number(reqHeaders['x-timer']) * 1000 : DEFAULT_TIMEOUT, false, 'TimeoutError'),
            app.Hyperdrive(main.useHost).stat(main.usePath)
          ])
        } catch (error) {
          if(!reqHeaders['accept'] || !reqHeaders['accept'].includes('text/html') || !reqHeaders['accept'].includes('application/json')){
            return {statusCode: 400, headers: {'Content-Type': 'text/plain; charset=utf-8', 'X-Issue': error.name}, data: [error.message]}
          } else if(reqHeaders['accept'].includes('text/html')){
            return {statusCode: 400, headers: {'Content-Type': 'text/html; charset=utf-8', 'X-Issue': error.name}, data: [`<html><head><title>Fetch</title></head><body><div>${error.message}</div></body></html>`]}
          } else if(reqHeaders['accept'].includes('application/json')){
            return {statusCode: 400, headers: {'Content-Type': 'application/json; charset=utf-8', 'X-Issue': error.name}, data: [JSON.stringify(error.message)]}
          }
        }
        mainData.pid = app.Hyperdrive(main.useHost).key
        mainData.path = main.usePath
        mainData.link = 'hyper://' + mainData.pid + mainData.path
        if(mainData.isDirectory()){
          const getDir = await app.Hyperdrive(main.useHost).readdir(main.usePath, {recursive: true})
          if(getDir.length){
            for(const i of getDir){
              await app.Hyperdrive(main.useHost).unlink(main.usePath + i)
            }
          }
          await app.Hyperdrive(main.useHost).rmdir(main.usePath)
        } else if(mainData.isFile()){
          await app.Hyperdrive(main.useHost).unlink(main.usePath)
        } else {
          throw new Error('not a directory or file')
        }
        if(!reqHeaders['accept'] || !reqHeaders['accept'].includes('text/html') || !reqHeaders['accept'].includes('application/json')){
          let useData = ''
          for(const prop in mainData){
            useData += `${prop}: ${mainData[prop]}\n`
          }
          return {statusCode: 200, headers: {'Content-Type': 'text/plain; charset=utf-8'}, data: [useData]}
        } else if(reqHeaders['accept'].includes('text/html')){
          return {statusCode: 200, headers: {'Content-Type': 'text/html; charset=utf-8'}, data: [`<html><head><title>Fetch</title></head><body><div>${JSON.stringify(mainData)}</div></body></html>`]}
        } else if(reqHeaders['accept'].includes('application/json')){
          return {statusCode: 200, headers: {'Content-Type': 'application/json; charset=utf-8'}, data: [JSON.stringify(mainData)]}
        }
      } else {
        return {statusCode: 400, headers: {}, data: ['method is not supported']}
      }
    } catch (error) {
      return {statusCode: 500, headers: {}, data: [error.stack]}
    }
  })

  fetch.close = async () => {return await app.close()}

  return fetch
}