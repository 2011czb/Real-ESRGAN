import React, { useState, useCallback, useRef, useEffect } from 'react'
import { Upload, Button, Card, Progress, message, Space } from 'antd'
import { InboxOutlined, PlayCircleOutlined, StopOutlined } from '@ant-design/icons'
import type { UploadFile } from 'antd'
import ProcessingService, { EnhanceParams } from '../services/ProcessingService'
import { useAppStore } from '../store'

const { Dragger } = Upload

interface ImageUploaderProps {
  processingService: ProcessingService
}

const ImageUploader: React.FC<ImageUploaderProps> = ({ processingService }) => {
  const [fileList, setFileList] = useState<UploadFile[]>([])
  const [uploading, setUploading] = useState(false)
  const [progress, setProgress] = useState(0)
  const [progressMessage, setProgressMessage] = useState('')
  const [progressLogs, setProgressLogs] = useState<string[]>([])
  const [cancelling, setCancelling] = useState(false)
  const processingPromiseRef = useRef<Promise<any> | null>(null)

  const {
    setOriginalImage,
    setResultImage,
    setProcessingTime,
    setEndToEndTime,
    setBackendProcessingTime,
    setNrQualityScore,
    nrQualityEnabled,
    setInputSizeBytes,
    setOutputSizeBytes,
    setCpuPercent,
    setProcessMemMb,
    setGpuMemAllocatedMb,
    setGpuMemReservedMb,
    compressionEnabled,
    compressionType,
    compressionQuality,
    params,
    networkProfile,
    transportProtocol,
  } = useAppStore()

  // 简单的无参考质量评估：基于结果图的清晰度/对比度给出 0-100 评分
  const computeNoRefQuality = useCallback((dataUrl: string): Promise<number> => {
    return new Promise((resolve) => {
      const img = new Image()
      img.onload = () => {
        try {
          const canvas = document.createElement('canvas')
          const context = canvas.getContext('2d')
          if (!context) {
            resolve(0)
            return
          }

          // 降采样到较小尺寸，避免前端计算过慢
          const maxSize = 256
          let { width, height } = img
          const scale = Math.min(1, maxSize / Math.max(width, height))
          width = Math.max(1, Math.floor(width * scale))
          height = Math.max(1, Math.floor(height * scale))

          canvas.width = width
          canvas.height = height
          context.drawImage(img, 0, 0, width, height)

          const imageData = context.getImageData(0, 0, width, height)
          const data = imageData.data

          // 计算简单清晰度指标：灰度图的梯度方差（近似衡量纹理/边缘丰富度）
          const gray: number[] = new Array(width * height)
          for (let i = 0; i < width * height; i++) {
            const r = data[i * 4]
            const g = data[i * 4 + 1]
            const b = data[i * 4 + 2]
            gray[i] = 0.299 * r + 0.587 * g + 0.114 * b
          }

          let sumGrad = 0
          let sumGrad2 = 0
          let count = 0

          for (let y = 1; y < height - 1; y++) {
            for (let x = 1; x < width - 1; x++) {
              const idx = y * width + x
              const gx = gray[idx + 1] - gray[idx - 1]
              const gy = gray[idx + width] - gray[idx - width]
              const g2 = gx * gx + gy * gy
              sumGrad += g2
              sumGrad2 += g2 * g2
              count++
            }
          }

          if (count === 0) {
            resolve(0)
            return
          }

          const mean = sumGrad / count
          const mean2 = sumGrad2 / count
          const variance = Math.max(0, mean2 - mean * mean)

          // 将方差映射到 0-100 的区间（经验性压缩），系数调小以降低饱和度
          const score = Math.max(0, Math.min(100, Math.log10(variance + 1) * 10))
          resolve(score)
        } catch {
          resolve(0)
        }
      }
      img.onerror = () => resolve(0)
      img.src = dataUrl
    })
  }, [])

  const handleFileChange = useCallback((info: any) => {
    let newFileList = [...info.fileList]

    // 限制只能上传一张图片
    newFileList = newFileList.slice(-1)

    // 验证文件类型
    newFileList = newFileList.filter((file) => {
      if (file.type && !file.type.startsWith('image/')) {
        message.error(`${file.name} 不是有效的图像文件`)
        return false
      }
      return true
    })

    // 验证文件大小（50MB限制）
    newFileList = newFileList.filter((file) => {
      if (file.size && file.size > 50 * 1024 * 1024) {
        message.error(`${file.name} 文件过大，最大支持50MB`)
        return false
      }
      return true
    })

    setFileList(newFileList)

    // 预览原图
    if (newFileList.length > 0 && newFileList[0].originFileObj) {
      const reader = new FileReader()
      reader.onload = (e) => {
        setOriginalImage(e.target?.result as string)
      }
      reader.readAsDataURL(newFileList[0].originFileObj)
    }
  }, [setOriginalImage])

  const handleProcess = useCallback(async () => {
    if (fileList.length === 0 || !fileList[0].originFileObj) {
      message.warning('请先选择要处理的图像')
      return
    }

    // 记录端到端起始时间
    const tClick = performance.now()

    setUploading(true)
    setCancelling(false)
    setProgress(0)
    setProgressMessage('准备处理...')
    // 不自动清空 progressLogs，作为 WebSocket 历史输出保留
    setResultImage(null)

    try {
      let file = fileList[0].originFileObj as File
      const originalSize = file.size

      // 如果启用前端压缩，先通过 Canvas 进行压缩
      if (compressionEnabled && file) {
        const compressedFile = await new Promise<File | null>((resolve) => {
          const reader = new FileReader()
          reader.onload = () => {
            const img = new Image()
            img.onload = () => {
              try {
                const canvas = document.createElement('canvas')
                const ctx = canvas.getContext('2d')
                if (!ctx) {
                  resolve(null)
                  return
                }

                // 为避免大图导致前端内存/性能问题，限制最大边长
                const maxDim = 2048
                const scale = Math.min(1, maxDim / Math.max(img.width, img.height))
                const targetWidth = Math.max(1, Math.round(img.width * scale))
                const targetHeight = Math.max(1, Math.round(img.height * scale))

                canvas.width = targetWidth
                canvas.height = targetHeight
                ctx.drawImage(img, 0, 0, targetWidth, targetHeight)

                const mimeType =
                  compressionType === 'lossy' ? 'image/jpeg' : 'image/png'

                const quality = compressionType === 'lossy' ? compressionQuality : 1.0

                canvas.toBlob(
                  (blob) => {
                    if (!blob) {
                      resolve(null)
                      return
                    }
                    const newFile = new File([blob], file.name, {
                      type: mimeType,
                      lastModified: Date.now(),
                    })
                    resolve(newFile)
                  },
                  mimeType,
                  quality
                )
              } catch {
                resolve(null)
              }
            }
            img.onerror = () => resolve(null)
            img.src = reader.result as string
          }
          reader.onerror = () => resolve(null)
          reader.readAsDataURL(file)
        })

        if (compressedFile) {
          file = compressedFile
        }

        // 更新上传大小指标：使用压缩后的文件大小
        setInputSizeBytes(file.size)
      } else {
        // 未启用压缩时，使用原始文件大小且不做任何前端重编码
        setInputSizeBytes(originalSize)
      }

      const enhanceParams: EnhanceParams = {
        model_name: params.modelName,
        scale: params.scale,
        tile: params.tile,
        tile_pad: params.tilePad,
        pre_pad: params.prePad,
        face_enhance: params.faceEnhance,
        fp32: params.fp32,
        outscale: params.outscale || undefined,
      }

      let result: any

      if (transportProtocol === 'ws') {
        // 协议 A：WebSocket，带进度推送（记录流式进度日志）
        result = await processingService.enhanceImageWithProgress(
          file,
          enhanceParams,
          (progressValue, message) => {
            setProgress(progressValue)
            setProgressMessage(message)
            setProgressLogs((logs) => [
              ...logs,
              `[进度] ${new Date().toLocaleTimeString()} - ${message}（${progressValue.toFixed(0)}%）`,
            ])
          }
        )
      } else {
        // 协议 B：HTTP 同步接口，使用 networkProfile 进行网络延迟模拟
        setProgress(10)
        setProgressMessage('上传中...')

        result = await processingService.enhanceImage(file, enhanceParams, {
          networkProfile,
        })

        setProgress(90)
        setProgressMessage('服务器处理中...')
      }

      // 检查是否被取消
      if (result.status === 'cancelled') {
        message.info('处理已取消')
        setProgress(0)
        setProgressMessage('已取消')
        return
      }

      if (result.status === 'success' && result.result_image) {
        setResultImage(result.result_image)
        // 后端处理耗时（来自后端返回的 processing_time）
        if (result.processing_time) {
          setProcessingTime(result.processing_time)
          setBackendProcessingTime(result.processing_time)
        } else {
          setBackendProcessingTime(null)
        }

        // 端到端耗时（从点击到结果处理完成）
        const tDisplay = performance.now()
        const endToEndSeconds = (tDisplay - tClick) / 1000
        setEndToEndTime(endToEndSeconds)

        // 网络流量与资源占用（如果后端返回了）
        setInputSizeBytes(result.input_size_bytes ?? null)
        setOutputSizeBytes(result.output_size_bytes ?? null)
        setCpuPercent(result.cpu_percent ?? null)
        setProcessMemMb(result.process_mem_mb ?? null)
        setGpuMemAllocatedMb(result.gpu_mem_allocated_mb ?? null)
        setGpuMemReservedMb(result.gpu_mem_reserved_mb ?? null)

        // 在线无参考质量评估（可选）
        if (nrQualityEnabled) {
          try {
            const score = await computeNoRefQuality(result.result_image)
            setNrQualityScore(score)
          } catch {
            setNrQualityScore(null)
          }
        } else {
          setNrQualityScore(null)
        }

        message.success(
          `处理完成！后端耗时 ${result.processing_time?.toFixed(2)} 秒，端到端耗时 ${endToEndSeconds.toFixed(2)} 秒`
        )
      } else {
        message.error(result.error || '处理失败')
      }
    } catch (error: any) {
      // 如果是取消操作，不显示错误
      if (error.message && error.message.includes('取消')) {
        message.info('处理已取消')
      } else {
        message.error(error.message || '处理失败')
      }
    } finally {
      setUploading(false)
      setCancelling(false)
      processingPromiseRef.current = null
      // 保留本次处理的 progressLogs 供滚动查看，只重置进度数值
      if (!cancelling) {
        setProgress(0)
        setProgressMessage('')
      }
    }
  }, [
    fileList,
    params,
    processingService,
    setResultImage,
    setProcessingTime,
    setEndToEndTime,
    setBackendProcessingTime,
    nrQualityEnabled,
    setNrQualityScore,
    computeNoRefQuality,
    cancelling,
  ])

  // WebSocket 模式下的心跳日志：在上传期间每隔固定时间追加一条状态
  useEffect(() => {
    if (!uploading || transportProtocol !== 'ws') {
      return
    }

    const interval = window.setInterval(() => {
      // 假进度：在 30%-90% 区间内缓慢推进，等待服务器真实结果
      setProgress((prev) => {
        const next = prev >= 90 ? prev : Math.min(90, prev + 5)
        if (next !== prev) {
          setProgressLogs((logs) => [
            ...logs,
            `[假进度] ${new Date().toLocaleTimeString()} - 估算进度约 ${next.toFixed(
              0
            )}%（等待服务器结果）`,
          ])
        }
        return next
      })
    }, 3000)

    return () => {
      window.clearInterval(interval)
    }
  }, [uploading, transportProtocol])

  const handleCancel = useCallback(async () => {
    if (processingService.isProcessing()) {
      setCancelling(true)
      setProgressMessage('正在取消...')
      const cancelled = await processingService.cancelProcessing()
      if (cancelled) {
        message.info('已发送取消请求，正在清理内存...')
      } else {
        message.warning('无法取消，连接可能已断开')
        setUploading(false)
        setCancelling(false)
        setProgress(0)
        setProgressMessage('')
      }
    }
  }, [processingService])

  const handleRemove = useCallback(() => {
    setFileList([])
    setOriginalImage(null)
    setResultImage(null)
  }, [setOriginalImage, setResultImage])

  return (
    <Card title="图像上传" bordered={false}>
      <Space direction="vertical" style={{ width: '100%' }} size="large">
        <Dragger
          fileList={fileList}
          onChange={handleFileChange}
          onRemove={handleRemove}
          beforeUpload={() => false} // 阻止自动上传
          accept="image/*"
          maxCount={1}
          disabled={uploading}
        >
          <p className="ant-upload-drag-icon">
            <InboxOutlined />
          </p>
          <p className="ant-upload-text">点击或拖拽图像文件到此区域上传</p>
          <p className="ant-upload-hint">
            支持 JPG、PNG、WebP、BMP 格式，最大 50MB
          </p>
        </Dragger>

        {uploading && (
          <div>
            <Progress
              percent={progress}
              status="active"
              format={(percent) => `${percent}%`}
            />
            <div style={{ marginTop: 8, color: '#666' }}>
              {progressMessage}
            </div>

            {transportProtocol === 'ws' && progressLogs.length > 0 && (
              <div
                style={{
                  marginTop: 8,
                  padding: '8px 12px',
                  background: '#fafafa',
                  border: '1px solid #f0f0f0',
                  borderRadius: 4,
                  maxHeight: 160,
                  overflowY: 'auto',
                  fontSize: 12,
                  color: '#555',
                }}
              >
                {progressLogs.map((log, index) => (
                  <div key={index}>{log}</div>
                ))}
              </div>
            )}
          </div>
        )}

        <Space direction="vertical" style={{ width: '100%' }} size="middle">
          <Button
            type="primary"
            icon={<PlayCircleOutlined />}
            onClick={handleProcess}
            loading={uploading && !cancelling}
            disabled={fileList.length === 0 || cancelling}
            block
            size="large"
          >
            {uploading ? '处理中...' : '开始处理'}
          </Button>

          {uploading && (
            <Button
              danger
              icon={<StopOutlined />}
              onClick={handleCancel}
              loading={cancelling}
              disabled={cancelling}
              block
            >
              {cancelling ? '正在取消...' : '取消处理'}
            </Button>
          )}
        </Space>
      </Space>
    </Card>
  )
}

export default ImageUploader

