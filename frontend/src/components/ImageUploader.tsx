import React, { useState, useCallback, useRef } from 'react'
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
  const [cancelling, setCancelling] = useState(false)
  const processingPromiseRef = useRef<Promise<any> | null>(null)
  
  const { 
    setOriginalImage, 
    setResultImage, 
    setProcessingTime,
    params 
  } = useAppStore()

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

    setUploading(true)
    setCancelling(false)
    setProgress(0)
    setProgressMessage('准备处理...')
    setResultImage(null)

    try {
      const file = fileList[0].originFileObj
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

      // 使用WebSocket方式获取实时进度
      const promise = processingService.enhanceImageWithProgress(
        file,
        enhanceParams,
        (progressValue, message) => {
          setProgress(progressValue)
          setProgressMessage(message)
        }
      )
      processingPromiseRef.current = promise

      const result = await promise

      // 检查是否被取消
      if (result.status === 'cancelled') {
        message.info('处理已取消')
        setProgress(0)
        setProgressMessage('已取消')
        return
      }

      if (result.status === 'success' && result.result_image) {
        setResultImage(result.result_image)
        if (result.processing_time) {
          setProcessingTime(result.processing_time)
        }
        message.success(`处理完成！耗时 ${result.processing_time?.toFixed(2)} 秒`)
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
      if (!cancelling) {
        setProgress(0)
        setProgressMessage('')
      }
    }
  }, [fileList, params, processingService, setResultImage, setProcessingTime, cancelling])

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

