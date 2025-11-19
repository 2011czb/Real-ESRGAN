import React from 'react'
import { Card, Space, Image, Button, Typography, Empty } from 'antd'
import { DownloadOutlined, SwapOutlined } from '@ant-design/icons'
import { useAppStore } from '../store'

const { Title } = Typography

const ResultDisplay: React.FC = () => {
  const { originalImage, resultImage, processingTime } = useAppStore()

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
        {processingTime && (
          <div style={{ textAlign: 'center' }}>
            <Typography.Text type="secondary">
              处理时间: {processingTime.toFixed(2)} 秒
            </Typography.Text>
          </div>
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

