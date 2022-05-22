const mime = require('mime/lite')
const SDK = require('hyper-sdk')
const parseRange = require('range-parser')
const { Readable } = require('stream')
const makeFetch = require('make-fetch')
const { EventIterator } = require('event-iterator')
const Busboy = require('busboy')
const path = require('path')

module.exports = async function makeHyperFetch (opts = {}) {
  const DEFAULT_OPTS = {}
  const finalOpts = { ...DEFAULT_OPTS, ...opts }
  const app = await (async (finalOpts) => {if(finalOpts.sdk){return finalOpts.sdk}else{return await SDK(finalOpts)}})(finalOpts)
  await app.Hyperdrive('fetch').ready()
  const DEFAULT_TIMEOUT = 10000
  const encodeType = '~'
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

  async function saveData (mid, content, useHeaders, timer) {
    const data = []
    const busboy = Busboy({ headers: useHeaders })

    const toUpload = new EventIterator(({ push, stop, fail }) => {
      function handleOff(){
        busboy.off('error', handleError)
        busboy.off('finish', handleFinish)
        busboy.off('file', handleFiles)
      }
      function handleFinish(){
        handleOff()
        stop()
      }
      function handleError(error){
        handleOff()
        fail(error)
      }
      function handleFiles(fieldName, fileData, info){
        const usePath = mid.usePath + info.filename
        data.push(usePath)
        try {
          push(app.Hyperdrive(mid.useHost).writeFile(usePath, Readable.from(fileData)))
        } catch (e) {
          fail(e)
        }
      }
      busboy.on('error', handleError)
      busboy.on('finish', handleFinish)

      busboy.on('file', handleFiles)
    })

    // Parse body as a multipart form
    // TODO: Readable.from doesn't work in browsers
    Readable.from(content).pipe(busboy)

    // toUpload is an async iterator of promises
    // We collect the promises (all files are queued for upload)
    // Then we wait for all of them to resolve
    // await Promise.all(await collect(toUpload))
    await Promise.race([
      new Promise((resolve, reject) => setTimeout(() => reject(new Error('timed out while saving data')), timer)),
      Promise.all(await collect(toUpload))
    ])
    return data
  }

  async function iterFiles(data, main){
    const result = []
    for(const i of data){
      const useData = await app.Hyperdrive(main.useHost).stat(i)
      useData.pid  = app.Hyperdrive(main.useHost).key
      useData.file = i
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

  async function collect (iterable) {
    const result = []
    for await (const item of iterable) {
      result.push(item)
    }
  }

  const fetch = makeFetch(async (request) => {

    const { url, headers: reqHeaders, method, signal, body } = request

    try {
      const { hostname, pathname, protocol, searchParams } = new URL(url)
      const mainHostname = hostname && hostname[0] === encodeType ? Buffer.from(hostname.slice(1), 'hex').toString('utf-8') : hostname

      if (protocol !== 'hyper:') {
        return { statusCode: 409, headers: {}, data: ['wrong protocol'] }
      } else if (!method || !SUPPORTED_METHODS.includes(method)) {
        return { statusCode: 409, headers: {}, data: ['something wrong with method'] }
      } else if (!mainHostname) {
        return { statusCode: 409, headers: {}, data: ['something wrong with hostname'] }
      }

      const main = formatReq(mainHostname, pathname)

      if(method === 'HEAD'){
        try {
          let mainData = await Promise.race([
            useTimeOut(new Error('this was timed out'), reqHeaders['x-timer'] && reqHeaders['x-timer'] !== '0' ? Number(reqHeaders['x-timer']) * 1000 : DEFAULT_TIMEOUT, false, 'TimeoutError'),
            app.Hyperdrive(main.useHost).stat(main.usePath)
          ])
          return {statusCode: 200, headers: {'Link': `<hyper://${main.useHost}${main.usePath}>; rel="canonical"`, 'Content-Length': `${mainData.size}`}, data: []}
        } catch (error) {
          return {statusCode: 400, headers: {'X-Issue': error.message}, data: []}
        }
      } else if(method === 'GET'){
        try {
          let mainData = await Promise.race([
            useTimeOut(new Error('this was timed out'), reqHeaders['x-timer'] && reqHeaders['x-timer'] !== '0' ? Number(reqHeaders['x-timer']) * 1000 : DEFAULT_TIMEOUT, false, 'TimeoutError'),
            app.Hyperdrive(main.useHost).stat(main.usePath)
          ])
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
                  return {statusCode: 206, headers: {'Content-Type': `${getMimeType(main)}`, 'Link': `<hyper://${main.useHost}${main.usePath}>; rel="canonical"`, 'Content-Length': `${length}`, 'Content-Range': `bytes ${start}-${end}/${mainData.size}`}, data: app.Hyperdrive(main.useHost).createReadStream(main.usePath, {start, end})}
                } else {
                  return {statusCode: 200, headers: {'Content-Type': `${getMimeType(main)}`, 'Link': `<hyper://${main.useHost}${main.usePath}>; rel="canonical"`, 'Content-Length': `${mainData.size}`}, data: app.Hyperdrive(main.useHost).createReadStream(main.usePath)}
                }
              } else {
                return {statusCode: 200, headers: {'Content-Type': `${getMimeType(main)}`, 'Link': `<hyper://${main.useHost}${main.usePath}>; rel="canonical"`, 'Content-Length': `${mainData.size}`}, data: app.Hyperdrive(main.useHost).createReadStream(main.usePath)}
              }
          } else {
            throw new Error('not a directory or file')
          }
        } catch (error) {
          return {statusCode: 400, headers: {'X-Issue': error.message}, data: []}
        }
      } else if(method === 'PUT'){
        try {
          let mainData = await saveData(main, body, headers, reqHeaders['x-timer'] && reqHeaders['x-timer'] !== '0' ? Number(reqHeaders['x-timer']) * 1000 : DEFAULT_TIMEOUT)
          if(main.usePath === '/'){
            mainData = await iterFiles(mainData, main)
          } else {
            mainData = await app.Hyperdrive(main.useHost).readdir(main.usePath)
            mainData = mainData.map(data => {return {path: data, link: 'hyper://' + app.Hyperdrive(main.useHost).key + data, pid: app.Hyperdrive(main.useHost).key}})
          }
          if(!reqHeaders['accept'] || !reqHeaders['accept'].includes('text/html') || !reqHeaders['accept'].includes('application/json')){
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
        } catch (error) {
          if(!reqHeaders['accept'] || !reqHeaders['accept'].includes('text/html') || !reqHeaders['accept'].includes('application/json')){
            return {statusCode: 400, headers: {'Content-Type': 'text/plain; charset=utf-8', 'X-Issue': error.name}, data: [error.message]}
          } else if(reqHeaders['accept'].includes('text/html')){
            return {statusCode: 400, headers: {'Content-Type': 'text/html; charset=utf-8', 'X-Issue': error.name}, data: [`<html><head><title>Fetch</title></head><body><div>${error.message}</div></body></html>`]}
          } else if(reqHeaders['accept'].includes('application/json')){
            return {statusCode: 400, headers: {'Content-Type': 'application/json; charset=utf-8', 'X-Issue': error.name}, data: [JSON.stringify(error.message)]}
          }
        }
      } else if(method === 'DELETE'){
        try {
          let mainData = await Promise.race([
            useTimeOut(new Error('this was timed out'), reqHeaders['x-timer'] && reqHeaders['x-timer'] !== '0' ? Number(reqHeaders['x-timer']) * 1000 : DEFAULT_TIMEOUT, false, 'TimeoutError'),
            app.Hyperdrive(main.useHost).stat(main.usePath)
          ])
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
        } catch (error) {
          if(!reqHeaders['accept'] || !reqHeaders['accept'].includes('text/html') || !reqHeaders['accept'].includes('application/json')){
            return {statusCode: 400, headers: {'Content-Type': 'text/plain; charset=utf-8', 'X-Issue': error.name}, data: [error.message]}
          } else if(reqHeaders['accept'].includes('text/html')){
            return {statusCode: 400, headers: {'Content-Type': 'text/html; charset=utf-8', 'X-Issue': error.name}, data: [`<html><head><title>Fetch</title></head><body><div>${error.message}</div></body></html>`]}
          } else if(reqHeaders['accept'].includes('application/json')){
            return {statusCode: 400, headers: {'Content-Type': 'application/json; charset=utf-8', 'X-Issue': error.name}, data: [JSON.stringify(error.message)]}
          }
        }
      } else {
        return {statusCode: 400, headers: {}, data: ['method is not supported']}
      }
    } catch (error) {
      return {statusCode: 500, headers: {}, data: [error.stack]}
    }
  })

  fetch.close = async () => {return await app.close()}
}