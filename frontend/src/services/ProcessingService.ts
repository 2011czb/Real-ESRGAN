/**
 * 处理服务类
 * 支持本地和云端处理模式切换
 */
import axios from 'axios'

export interface EnhanceParams {
  model_name?: string
  scale?: number
  tile?: number
  tile_pad?: number
  pre_pad?: number
  face_enhance?: boolean
  fp32?: boolean
  outscale?: number
}

export interface EnhanceResult {
  status: string
  result_image?: string
  processing_time?: number
  image_mode?: string
  error?: string
  cancelled?: boolean
}

export interface ProgressCallback {
  (progress: number, message: string): void
}

class ProcessingService {
  private baseURL: string
  private processingMode: 'local' | 'cloud' = 'local'
  private cloudEndpoints: Record<string, string> = {}
  private currentWebSocket: WebSocket | null = null

  constructor(baseURL: string = 'http://localhost:8000') {
    this.baseURL = baseURL
  }

  /**
   * 设置处理模式
   */
  setMode(mode: 'local' | 'cloud') {
    this.processingMode = mode
    // 通知后端
    axios.post(`${this.baseURL}/api/v1/config/mode`, null, {
      params: { mode }
    }).catch(err => {
      console.error('设置处理模式失败:', err)
    })
  }

  /**
   * 设置云端接口地址
   */
  setCloudEndpoints(endpoints: Record<string, string>) {
    this.cloudEndpoints = endpoints
    axios.post(`${this.baseURL}/api/v1/config/cloud-endpoints`, endpoints)
      .catch(err => {
        console.error('设置云端接口失败:', err)
      })
  }

  /**
   * 处理图像（同步方式）
   */
  async enhanceImage(
    file: File,
    params: EnhanceParams = {}
  ): Promise<EnhanceResult> {
    const formData = new FormData()
    formData.append('file', file)
    formData.append('model_name', params.model_name || 'RealESRGAN_x4plus')
    formData.append('scale', String(params.scale || 4.0))
    formData.append('tile', String(params.tile || 0))
    formData.append('tile_pad', String(params.tile_pad || 10))
    formData.append('pre_pad', String(params.pre_pad || 0))
    formData.append('face_enhance', String(params.face_enhance || false))
    formData.append('fp32', String(params.fp32 || false))
    if (params.outscale) {
      formData.append('outscale', String(params.outscale))
    }
    formData.append('processing_mode', this.processingMode)

    try {
      const response = await axios.post<EnhanceResult>(
        `${this.baseURL}/api/v1/enhance`,
        formData,
        {
          headers: {
            'Content-Type': 'multipart/form-data',
          },
          timeout: 300000, // 5分钟超时
        }
      )
      return response.data
    } catch (error: any) {
      return {
        status: 'error',
        error: error.response?.data?.detail || error.message || '处理失败',
      }
    }
  }

  /**
   * 处理图像（WebSocket实时进度）
   */
  async enhanceImageWithProgress(
    file: File,
    params: EnhanceParams = {},
    onProgress?: ProgressCallback
  ): Promise<EnhanceResult> {
    return new Promise((resolve, reject) => {
      // 将文件转换为base64
      const reader = new FileReader()
      reader.onload = () => {
        const base64Image = reader.result as string

        // 建立WebSocket连接
        const ws = new WebSocket(
          this.baseURL.replace('http', 'ws') + '/api/v1/enhance/stream'
        )
        this.currentWebSocket = ws

        ws.onopen = () => {
          // 发送处理请求
          ws.send(
            JSON.stringify({
              type: 'start',
              image: base64Image,
              model_name: params.model_name || 'RealESRGAN_x4plus',
              scale: params.scale || 4.0,
              tile: params.tile || 0,
              tile_pad: params.tile_pad || 10,
              pre_pad: params.pre_pad || 0,
              face_enhance: params.face_enhance || false,
              fp32: params.fp32 || false,
              outscale: params.outscale,
              processing_mode: this.processingMode,
            })
          )
        }

        ws.onmessage = (event) => {
          const data = JSON.parse(event.data)

          if (data.type === 'progress') {
            // 进度更新
            if (onProgress) {
              onProgress(data.progress, data.message)
            }
          } else if (data.type === 'result') {
            // 处理完成
            this.currentWebSocket = null
            ws.close()
            resolve({
              status: 'success',
              result_image: data.result_image,
              processing_time: data.processing_time,
              image_mode: data.image_mode,
            })
          } else if (data.type === 'cancelled') {
            // 处理已取消
            this.currentWebSocket = null
            ws.close()
            resolve({
              status: 'cancelled',
              error: data.message || '处理已取消',
            })
          } else if (data.type === 'error') {
            // 处理失败
            this.currentWebSocket = null
            ws.close()
            reject(new Error(data.message))
          }
        }

        ws.onerror = (error) => {
          this.currentWebSocket = null
          ws.close()
          reject(error)
        }

        ws.onclose = () => {
          this.currentWebSocket = null
          // 连接关闭
        }
      }

      reader.onerror = () => {
        reject(new Error('文件读取失败'))
      }

      reader.readAsDataURL(file)
    })
  }

  /**
   * 取消当前处理任务
   */
  cancelProcessing(): boolean {
    if (this.currentWebSocket && this.currentWebSocket.readyState === WebSocket.OPEN) {
      try {
        // 发送文本消息（后端使用 receive_text 接收）
        this.currentWebSocket.send(JSON.stringify({ type: 'cancel' }))
        return true
      } catch (error) {
        console.error('发送取消请求失败:', error)
        return false
      }
    }
    return false
  }

  /**
   * 检查是否有正在进行的任务
   */
  isProcessing(): boolean {
    return this.currentWebSocket !== null && 
           this.currentWebSocket.readyState === WebSocket.OPEN
  }

  /**
   * 获取当前处理模式
   */
  getMode(): 'local' | 'cloud' {
    return this.processingMode
  }
}

export default ProcessingService

