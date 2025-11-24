import React, { useState, useCallback, useRef, useEffect } from 'react'
import { Upload, Button, Card, Progress, message, Space } from 'antd'
import { InboxOutlined, PlayCircleOutlined, StopOutlined, DownloadOutlined } from '@ant-design/icons'
import type { UploadFile } from 'antd'
import imageCompression from 'browser-image-compression'
import ProcessingService, { EnhanceParams } from '../services/ProcessingService'
import { useAppStore } from '../store'

const { Dragger } = Upload

interface ImageUploaderProps {
  processingService: ProcessingService
}

const ImageUploader: React.FC<ImageUploaderProps> = ({ processingService }) => {
  const [fileList, setFileList] = useState<UploadFile[]>([])
  const [resultList, setResultList] = useState<
    {
      name: string
      url: string
      processingTime?: number | null
      endToEndTime?: number | null
      inputSizeBytes?: number | null
      outputSizeBytes?: number | null
      cpuPercent?: number | null
      processMemMb?: number | null
      gpuMemAllocatedMb?: number | null
      gpuMemReservedMb?: number | null
      nrQualityScore?: number | null
    }[]
  >([])
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

  const handleDownload = useCallback((imageUrl: string, filename: string) => {
    const link = document.createElement('a')
    link.href = imageUrl
    link.download = filename
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
  }, [])

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

    // 预览原图：默认展示第一张选中的图片
    if (newFileList.length > 0 && newFileList[0].originFileObj) {
      const reader = new FileReader()
      reader.onload = (e) => {
        setOriginalImage(e.target?.result as string)
      }
      reader.readAsDataURL(newFileList[0].originFileObj)
    }
  }, [setOriginalImage])

  const handleProcess = useCallback(async () => {
    if (fileList.length === 0) {
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

      // 抽取单张图片的处理逻辑，便于在云端模式下并行处理
      const processSingleFile = async (uploadFile: UploadFile) => {
        if (!uploadFile.originFileObj) return

        let file = uploadFile.originFileObj as File
        const originalSize = file.size

        // 如果启用前端压缩，使用 browser-image-compression 进行压缩
        if (compressionEnabled && file) {
          try {
            const options = {
              // 为避免大图导致前端内存/性能问题，限制最大边长
              maxWidthOrHeight: 2048,
              // 有损压缩时使用传入的压缩质量；无损时保持质量为 1
              initialQuality: compressionType === 'lossy' ? compressionQuality : 1.0,
              useWebWorker: true,
              fileType: compressionType === 'lossy' ? 'image/jpeg' : 'image/png',
            } as const

            const compressedFile = await imageCompression(file, options)
            if (compressedFile && compressedFile.size > 0) {
              file = compressedFile as File
            }
          } catch {
            // 压缩失败时退回到原始文件，避免阻塞整体流程
            file = file
          }

          // 更新上传大小指标：使用压缩后的文件大小
          setInputSizeBytes(file.size)
        } else {
          // 未启用压缩时，使用原始文件大小且不做任何前端重编码
          setInputSizeBytes(originalSize)
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
          let qualityScore: number | null = null
          if (nrQualityEnabled) {
            try {
              const score = await computeNoRefQuality(result.result_image)
              qualityScore = score
              setNrQualityScore(score)
            } catch {
              qualityScore = null
              setNrQualityScore(null)
            }
          } else {
            setNrQualityScore(null)
          }

          // 后端处理耗时（来自后端返回的 processing_time）
          if (result.processing_time) {
            setProcessingTime(result.processing_time)
            setBackendProcessingTime(result.processing_time)
          } else {
            setBackendProcessingTime(null)
          }

          // 将本次结果及其指标追加到结果列表中，避免被后续图片覆盖
          setResultList((list) => [
            ...list,
            {
              name: uploadFile.name,
              url: result.result_image,
              processingTime: result.processing_time ?? null,
              endToEndTime: endToEndSeconds,
              inputSizeBytes: result.input_size_bytes ?? null,
              outputSizeBytes: result.output_size_bytes ?? null,
              cpuPercent: result.cpu_percent ?? null,
              processMemMb: result.process_mem_mb ?? null,
              gpuMemAllocatedMb: result.gpu_mem_allocated_mb ?? null,
              gpuMemReservedMb: result.gpu_mem_reserved_mb ?? null,
              nrQualityScore: qualityScore,
            },
          ])

          message.success(
            `处理完成！后端耗时 ${result.processing_time?.toFixed(2)} 秒，端到端耗时 ${endToEndSeconds.toFixed(2)} 秒`
          )
        } else {
          message.error(result.error || '处理失败')
        }
      }

      const isCloudMode =
        typeof (processingService as any).getMode === 'function' &&
        (processingService as any).getMode() === 'cloud'

      // WebSocket 或本地模式：保持顺序处理，保证进度条体验
      if (transportProtocol === 'ws' || !isCloudMode) {
        for (const uploadFile of fileList) {
          // 依次处理选中的每一张图片
          // eslint-disable-next-line no-await-in-loop
          await processSingleFile(uploadFile)
        }
      } else {
        // 云端 + HTTP 模式：对多张图片并行发起请求，让后端和云端并行处理
        await Promise.all(fileList.map((uploadFile) => processSingleFile(uploadFile)))
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
      // 在 30%-90% 区间内缓慢推进，等待服务器真实结果
      setProgress((prev) => {
        const next = prev >= 90 ? prev : Math.min(90, prev + 5)
        if (next !== prev) {
          setProgressLogs((logs) => [
            ...logs,
            ` ${new Date().toLocaleTimeString()} - 处理进度 ${next.toFixed(
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
    setResultList([])
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

        {resultList.length > 0 && (
          <div style={{ width: '100%' }}>
            <div style={{ marginBottom: 8 }}>结果图预览：</div>
            <div
              style={{
                display: 'flex',
                flexWrap: 'wrap',
                gap: 12,
              }}
            >
              {resultList.map((item, index) => (
                <div key={`${item.name}-${index}`} style={{ width: 120, textAlign: 'center' }}>
                  <img
                    src={item.url}
                    alt={item.name}
                    style={{ width: '100%', height: 'auto', borderRadius: 4 }}
                  />
                  <div style={{ marginTop: 4, fontSize: 12, color: '#666' }}>{item.name}</div>
                  <div style={{ marginTop: 4 }}>
                    <Button
                      size="small"
                      icon={<DownloadOutlined />}
                      onClick={() => handleDownload(item.url, item.name || `result-${index + 1}.png`)}
                    >
                      下载
                    </Button>
                  </div>
                </div>
              ))}
            </div>

            <div style={{ marginTop: 16 }}>
              <div style={{ marginBottom: 8 }}>图片指标参数：</div>
              <div
                style={{
                  maxHeight: 240,
                  overflowY: 'auto',
                  border: '1px solid #f0f0f0',
                  borderRadius: 4,
                  padding: '8px 12px',
                  fontSize: 12,
                  color: '#555',
                }}
              >
                {resultList.map((item, index) => (
                  <div
                    key={`metrics-${item.name}-${index}`}
                    style={{
                      padding: '6px 0',
                      borderBottom: index === resultList.length - 1 ? 'none' : '1px solid #f5f5f5',
                    }}
                  >
                    <div style={{ fontWeight: 500 }}>{item.name}</div>
                    <div>后端耗时：{item.processingTime != null ? `${item.processingTime.toFixed(2)} s` : '—'}</div>
                    <div>端到端耗时：{item.endToEndTime != null ? `${item.endToEndTime.toFixed(2)} s` : '—'}</div>
                    <div>
                      输入大小：
                      {item.inputSizeBytes != null
                        ? `${(item.inputSizeBytes / 1024 / 1024).toFixed(2)} MB`
                        : '—'}
                    </div>
                    <div>
                      输出大小：
                      {item.outputSizeBytes != null
                        ? `${(item.outputSizeBytes / 1024 / 1024).toFixed(2)} MB`
                        : '—'}
                    </div>
                    <div>
                      CPU 使用率：{item.cpuPercent != null ? `${item.cpuPercent.toFixed(1)} %` : '—'}
                    </div>
                    <div>
                      进程内存：
                      {item.processMemMb != null ? `${item.processMemMb.toFixed(1)} MB` : '—'}
                    </div>
                    <div>
                      GPU 显存占用：
                      {item.gpuMemAllocatedMb != null
                        ? `${item.gpuMemAllocatedMb.toFixed(1)} MB`
                        : '—'}
                    </div>
                    <div>
                      GPU 预留显存：
                      {item.gpuMemReservedMb != null
                        ? `${item.gpuMemReservedMb.toFixed(1)} MB`
                        : '—'}
                    </div>
                    <div>
                      无参考质量评分：
                      {item.nrQualityScore != null ? item.nrQualityScore.toFixed(1) : '—'}
                    </div>
                  </div>
                ))}
              </div>
            </div>
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

