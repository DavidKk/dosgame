import * as path from 'path'
import { EventEmitter } from 'events'
import defaultsDeep from 'lodash/defaultsDeep'
import { AxiosRequestConfig } from 'axios'
import WDOSBOX from '../vendors/wdosbox'
import request, { CancelToken } from '../services/request'
import dosConf from '../conf/dos'
import version from '../conf/version'

export default class DosBox {
  private emitter: EventEmitter = new EventEmitter()
  private options: HostOptions = { wasmUrl: './wdosbox.wasm.js' }
  private canvas: HTMLCanvasElement = null
  private wdosboxModule: WdosboxModule = null
  private wasmModule: WebAssembly.Module = null
  private shellInputQueue: string[] = []
  private shellInputClients: Array<() => void> = []
  private isAlive: boolean = true
  private isInitialized: boolean = false
  private isReady: boolean = false
  private fetchTasks: Array<FetchTask> = []

  constructor (canvas: HTMLCanvasElement, options: HostOptions = {}) {
    this.options = defaultsDeep(this.options, options)
    this.canvas = canvas
  }

  public async play (game: GameInfo) {
    const { ID, URL, COMMAND } = game
    const { mainFn } = await this.compile()

    await this.extract(URL)
    await mainFn(COMMAND)

    const { FS } = this.wdosboxModule
    let indexedDB = <IDBFactory>FS.indexedDB()
    let openRequest = indexedDB.open(FS.DB_NAME(), FS.DB_VERSION)

    openRequest.onupgradeneeded = () => {
      let db = openRequest.result
      db.createObjectStore(ID)
    }
  }

  public compile (wasmUrl?: string, options: HostOptions = {}): Promise<any> {
    options = defaultsDeep({ wasmUrl }, options, this.options)

    const instantiateWasm = (info, receiveInstance) => {
      return WebAssembly.instantiate(this.wasmModule, info).then((instance) => {
        return receiveInstance(instance, this.wasmModule)
      })
    }

    const onRuntimeInitialized = () => {
      let mainFn = (args: string[] = []): Promise<void> => {
        return new Promise((resolve) => {
          this.createFile('/home/web_user/.dosbox/dosbox-jsdos.conf', dosConf)
          args.unshift('-userconf', '-c', 'mount c .', '-c', 'c:')
          this.wdosboxModule.callMain(args)

          this.emitter.once('ready', resolve)
        })
      }

      this.isInitialized = true
      this.emitter.emit('runtimeInitialized', { mainFn })
    }

    const ping = (message: string, ...args: any[]) => {
      if (this.isAlive !== true) {
        return
      }

      switch (message) {
        case 'ready': {
          this.isReady = true
          this.emitter.emit('ready')
          break
        }

        case 'shell_input': {
          if (this.shellInputQueue.length === 0) {
            break
          }

          const buffer: number = args[0]
          const maxLength: number = args[1]

          const cmd = this.shellInputQueue.shift()
          const cmdLength = this.wdosboxModule.lengthBytesUTF8(cmd) + 1

          if (cmdLength > maxLength) {
            throw new Error(`Can't execute cmd '${cmd}', because it's bigger then max cmd length ${maxLength}`)
          }

          this.wdosboxModule.stringToUTF8(cmd, buffer, cmdLength)

          if (this.shellInputQueue.length === 0) {
            for (const resolve of this.shellInputClients) {
              resolve()
            }

            this.shellInputClients = []
          } else {
            this.requestShellInput()
          }
        }
      }
    }

    this.wdosboxModule = {
      canvas: this.canvas,
      version,
      instantiateWasm,
      onRuntimeInitialized,
      ping
    } as WdosboxModule

    const onDownloadProgress = () => {
      // const { loaded, total } = event
    }

    const requestOptions: AxiosRequestConfig = {
      responseType: 'arraybuffer',
      onDownloadProgress
    }

    return new Promise((resolve, reject) => {
      this.emitter.once('runtimeInitialized', resolve)

      this.fetchArrayBuffer(options.wasmUrl, requestOptions)
      .then((data) => WebAssembly.compile(data))
      .then((module) => {
        this.wasmModule = module
        WDOSBOX(this.wdosboxModule)
      })
      .catch(reject)
    })
  }

  public fetchArrayBuffer (url: string, options?: AxiosRequestConfig): Promise<ArrayBuffer> {
    const source = CancelToken.source()
    const token = source.token

    options = defaultsDeep({ responseType: 'arraybuffer', cancelToken: token }, options)

    const cancel = (message?: string) => source.cancel(message || 'Extract canceled.')
    const promise = request.get(url, options).then((response) => {
      const { data } = response
      if (!(data instanceof ArrayBuffer)) {
        return Promise.reject(new Error('Data is invalid'))
      }

      return Promise.resolve(data)
    })

    this.fetchTasks.push({ promise, cancel })
    return promise
  }

  public extract (url: string, type: string = 'zip'): Promise<void> {
    if (type !== 'zip') {
      Promise.reject(new Error('Only ZIP archive is supported'))
      return
    }

    return this.fetchArrayBuffer(url).then((data) => {
      const bytes = new Uint8Array(data)
      const buffer = this.wdosboxModule._malloc(bytes.length)
      this.wdosboxModule.HEAPU8.set(bytes, buffer)

      const code = this.wdosboxModule._extract_zip(buffer, bytes.length)
      this.wdosboxModule._free(buffer)

      if (code === 0) {
        return
      }

      return Promise.reject(new Error(`Can't extract zip, retcode ${code}, see more info in logs`))
    })
  }

  public createFile (file: string, body: ArrayBuffer | Uint8Array | string): void {
    if (body instanceof ArrayBuffer) {
      body = new Uint8Array(body)
    }

    file = file.replace(new RegExp('^[a-zA-z]+:'), '') .replace(new RegExp('\\\\', 'g'), '/')
    const parts = file.split('/')

    if (parts.length === 0) {
      throw new Error(`Can't create file '${file}', because it's not valid file path`)
    }

    const filename = parts[parts.length - 1].trim()
    if (filename.length === 0) {
      throw new Error(`Can't create file '${file}', because file name is empty`)
    }

    let path = '/'
    for (let i = 0; i < parts.length - 1; ++i) {
      const part = parts[i].trim()
      if (part.length === 0) {
        continue
      }

      this.wdosboxModule.FS_createPath(path, part, true, true)
      path = path + '/' + part
    }

    this.wdosboxModule.FS_createDataFile(path, filename, body, true, true, true)
  }

  public searchFiles (dir: string, pattern: RegExp): Promise<Array<string>> {
    return new Promise((resolve) => {
      let { FS } = this.wdosboxModule
      let files = FS.readdir(dir)
      files = files.filter((file) => pattern.test(file))
      resolve(files)
    })
  }

  public saveFilesToDB (files: string[], table: string = this.wdosboxModule.FS.DB_STORE_NAME): Promise<void> {
    if (files.length === 0) {
      return Promise.resolve()
    }

    return new Promise((resolve, reject) => {
      let { FS } = this.wdosboxModule
      let indexedDB = <IDBFactory>FS.indexedDB()
      let openRequest = indexedDB.open(FS.DB_NAME(), FS.DB_VERSION)

      openRequest.onupgradeneeded = () => {
        let db = openRequest.result
        db.createObjectStore(table)
      }

      openRequest.onerror = (error) => reject(error)

      openRequest.onsuccess = () => {
        const db = openRequest.result
        const transaction = db.transaction([table], 'readwrite')
        const store = transaction.objectStore(table)

        transaction.onerror = (error) => reject(error)

        let promises = files.map((file) => new Promise((resolve, reject) => {
          let stats = FS.analyzePath(file)
          if (stats.exists !== true) {
            reject(new Error(`File ${file} is not exists`))
            return
          }

          let content = FS.analyzePath(file).object.contents
          let putRequest = store.put(content, file)

          putRequest.onsuccess = () => resolve()
          putRequest.onerror = (error) => reject(error)
        }))

        return Promise.all(promises).then(() => resolve()).catch(reject)
      }
    })
  }

  public loadFilesFromDB (files: string[] | null, table: string = this.wdosboxModule.FS.DB_STORE_NAME): Promise<void> {
    return new Promise((resolve, reject) => {
      const { FS } = this.wdosboxModule
      const indexedDB = <IDBFactory>FS.indexedDB()
      const openRequest = indexedDB.open(FS.DB_NAME(), FS.DB_VERSION)

      openRequest.onupgradeneeded = () => reject(new Error(`Table ${table} is not exists`))
      openRequest.onerror = (error) => reject(error)

      openRequest.onsuccess = () => {
        const db = openRequest.result
        const transaction = db.transaction([table], 'readonly')
        const store = transaction.objectStore(table)
        
        const _putfiles = (files) => {
          const promises = files.map((file) => new Promise((resolve, reject) => {
            const getRequest = store.get(file)
  
            getRequest.onerror = (error) => reject(error)
            getRequest.onsuccess = () => {
              try {
                FS.analyzePath(file).exists && FS.unlink(file)
  
                let dir = path.dirname(file)
                let name = path.basename(file)
                let content = getRequest.result
    
                FS.createDataFile(dir, name, content, true, true, true)
                resolve()
              } catch (error) {
                reject(error)
              }
            }
          }))
  
          return Promise.all(promises)
        }

        if (Array.isArray(files)) {
          _putfiles(files).then(() => resolve()).catch(reject)
          return
        }

        const getRequest = store.getAllKeys()
        getRequest.onerror = (error) => reject(error)

        getRequest.onsuccess = () => {
          const files = getRequest.result
          _putfiles(files).then(() => resolve()).catch(reject)
        }
      }
    })
  }

  private sendKeyPress (code: number): void {
    if (this.isInitialized === true) {
      this.wdosboxModule.send('sdl_key_event', code + '')
    }
  }

  public requestShellInput (): void {
    this.sendKeyPress(13)
  }

  public shell (...cmd: string[]): Promise<void> {
    if (cmd.length === 0) {
      return Promise.resolve()
    }

    return new Promise((resolve) => {
      this.shellInputClients.push(resolve)

      for (const next of cmd) {
        this.shellInputQueue.push(next)
      }

      this.requestShellInput()
    })
  }

  public exit (): boolean {
    try {
      this.wdosboxModule.send('exit')
    } catch (error) {
      return false
    }

    return true
  }

  public setSize (width: number, height: number): void {
    if (this.isInitialized === true) {
      this.wdosboxModule.setCanvasSize(width, height)
    } else {
      this.canvas.style.width = `${width}px`
      this.canvas.style.height = `${height}px`
    }
  }

  public destroy (force: boolean = true): Promise<void> {
    return new Promise((resolve) => {
      const handleDestroyDosBox = () => {
        this.exit()

        this.fetchTasks.forEach((task) => task.cancel())
        this.emitter.removeAllListeners()

        this.shellInputQueue.splice(0)
        this.shellInputClients.splice(0)
        this.fetchTasks.splice(0)

        this.options = undefined
        this.emitter = undefined
        this.canvas = undefined
        this.wdosboxModule = undefined
        this.wasmModule = undefined
        this.shellInputQueue = undefined
        this.shellInputClients = undefined
        this.isAlive = undefined
        this.isInitialized = undefined
        this.isReady = undefined
        this.fetchTasks = undefined

        resolve()
      }

      if (force === true) {
        handleDestroyDosBox()
      } else if (this.isInitialized === false) {
        this.emitter.once('runtimeInitialized', handleDestroyDosBox)
      } else if (this.isReady === false) {
        this.emitter.once('ready', handleDestroyDosBox)
      } else {
        handleDestroyDosBox()
      }
    })
  }
}

interface HostOptions {
  wasmUrl?: string
}

interface WdosboxModule {
  version: string
  canvas: HTMLCanvasElement
  instantiateWasm: (info: object, receiveInstance: Function) => void
  onRuntimeInitialized: () => void
  ping: (message: string) => void
  [key: string]: any
}

interface FetchTask {
  promise: Promise<any>
  cancel: (message?: string) => void
}

interface GameInfo {
  ID: string
  NAME: string
  URL: string
  COMMAND: Array<string>
  SAVE: {
    PATH: string
    REGEXP: RegExp
  }
}
