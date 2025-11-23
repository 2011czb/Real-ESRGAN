import React, { useState } from 'react'
import { Card, Space, Image, Button, Typography, Empty } from 'antd'
import { DownloadOutlined, SwapOutlined } from '@ant-design/icons'
import { useAppStore } from '../store'

const { Title } = Typography

const ResultDisplay: React.FC = () => {
  const {
    originalImage,
    resultImage,
    processingTime,
    endToEndTime,
    backendProcessingTime,
    nrQualityScore,
    inputSizeBytes,
    outputSizeBytes,
    cpuPercent,
    processMemMb,
    gpuMemAllocatedMb,
    gpuMemReservedMb,
  } = useAppStore()
  const [showStats, setShowStats] = useState(false)

  const handleDownload = (imageUrl: string, filename: string) => {
    const link = document.createElement('a')
    link.href = imageUrl
    link.download = filename
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
  }

  if (!originalImage && !resultImage) {
    return (
      <Card title="处理结果" bordered={false}>
        <Empty description="请上传图像并开始处理" />
      </Card>
    )
  }

  return (
    <Card title="处理结果" bordered={false}>
      <Space direction="vertical" size="large" style={{ width: '100%' }}>
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <Button type="default" size="small" onClick={() => setShowStats((prev) => !prev)}>
            {showStats ? '收起性能与质量信息' : '查看性能与质量信息'}
          </Button>
        </div>

        {showStats && (
          <Card size="small" style={{ width: '100%' }}>
            <Space direction="vertical" style={{ width: '100%' }}>
              {endToEndTime && (
                <Typography.Text type="secondary">
                  端到端时间（点击到结果显示）: {endToEndTime.toFixed(2)} 秒
                </Typography.Text>
              )}
              {(backendProcessingTime || processingTime) && (
                <Typography.Text type="secondary">
                  后端处理时间（processing_time）: {(backendProcessingTime || processingTime)?.toFixed(2)} 秒
                </Typography.Text>
              )}
              {(inputSizeBytes !== null || outputSizeBytes !== null) && (
                <Typography.Text type="secondary">
                  上传大小: {inputSizeBytes !== null ? (inputSizeBytes / 1024).toFixed(1) : '-'} KB，
                  下载大小: {outputSizeBytes !== null ? (outputSizeBytes / 1024).toFixed(1) : '-'} KB
                </Typography.Text>
              )}
              {(cpuPercent !== null || processMemMb !== null) && (
                <Typography.Text type="secondary">
                  后端 CPU: {cpuPercent !== null ? cpuPercent.toFixed(1) : '-'}%，进程内存: {processMemMb !== null ? processMemMb.toFixed(1) : '-'} MB
                </Typography.Text>
              )}
              {(gpuMemAllocatedMb !== null || gpuMemReservedMb !== null) && (
                <Typography.Text type="secondary">
                  GPU 显存占用: 已用 {gpuMemAllocatedMb !== null ? gpuMemAllocatedMb.toFixed(1) : '-'} MB，预留 {gpuMemReservedMb !== null ? gpuMemReservedMb.toFixed(1) : '-'} MB
                </Typography.Text>
              )}
              {nrQualityScore !== null && (
                <Typography.Text type="secondary">
                  在线无参考质量评分（0-100，越高越好）: {nrQualityScore.toFixed(1)}
                </Typography.Text>
              )}
            </Space>
          </Card>
        )}

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24 }}>
          <div>
            <Title level={5} style={{ textAlign: 'center', marginBottom: 16 }}>
              原图
            </Title>
            {originalImage ? (
              <div style={{ textAlign: 'center' }}>
                <Image
                  src={originalImage}
                  alt="原图"
                  style={{ maxWidth: '100%', maxHeight: '500px' }}
                  preview={{
                    mask: '预览',
                  }}
                />
                <div style={{ marginTop: 16 }}>
                  <Button
                    icon={<DownloadOutlined />}
                    onClick={() => handleDownload(originalImage, 'original.png')}
                  >
                    下载原图
                  </Button>
                </div>
              </div>
            ) : (
              <Empty description="暂无原图" />
            )}
          </div>

          <div>
            <Title level={5} style={{ textAlign: 'center', marginBottom: 16 }}>
              修复后
            </Title>
            {resultImage ? (
              <div style={{ textAlign: 'center' }}>
                <Image
                  src={resultImage}
                  alt="修复后"
                  style={{ maxWidth: '100%', maxHeight: '500px' }}
                  preview={{
                    mask: '预览',
                  }}
                />
                <div style={{ marginTop: 16 }}>
                  <Button
                    type="primary"
                    icon={<DownloadOutlined />}
                    onClick={() => handleDownload(resultImage, 'enhanced.png')}
                  >
                    下载结果
                  </Button>
                </div>
              </div>
            ) : (
              <Empty description="处理中或处理失败" />
            )}
          </div>
        </div>
      </Space>
    </Card>
  )
}

export default ResultDisplay

