import React from 'react'
import { Card, Form, Select, InputNumber, Switch, Space, Divider } from 'antd'
import { useAppStore } from '../store'

const ParameterPanel: React.FC = () => {
  const { params, updateParams } = useAppStore()

  return (
    <Card title="处理参数" bordered={false}>
      <Form layout="vertical" size="middle">
        <Form.Item label="模型选择">
          <Select
            value={params.modelName}
            onChange={(value) => updateParams({ modelName: value })}
            options={[
              { label: 'RealESRGAN_x4plus (通用)', value: 'RealESRGAN_x4plus' },
              { label: 'RealESRGAN_x4plus_anime_6B (动漫)', value: 'RealESRGAN_x4plus_anime_6B' },
              { label: 'RealESRGAN_x2plus (2倍)', value: 'RealESRGAN_x2plus' },
              { label: 'realesr-animevideov3 (动漫视频)', value: 'realesr-animevideov3' },
              { label: 'realesr-general-x4v3 (通用v3)', value: 'realesr-general-x4v3' },
            ]}
          />
        </Form.Item>

        <Form.Item label="缩放比例 (outscale)">
          <InputNumber
            value={params.outscale}
            onChange={(value) => updateParams({ outscale: value || 4.0 })}
            min={1.0}
            max={8.0}
            step={0.1}
            style={{ width: '100%' }}
          />
        </Form.Item>

        <Divider />

        <Form.Item label="Tile 大小">
          <Select
            value={params.tile}
            onChange={(value) => updateParams({ tile: value })}
            options={[
              { label: '不分块 (0)', value: 0 },
              { label: '200', value: 200 },
              { label: '400', value: 400 },
              { label: '600', value: 600 },
              { label: '800', value: 800 },
            ]}
          />
          <div style={{ marginTop: 4, fontSize: 12, color: '#999' }}>
            大图像建议使用分块处理，避免内存不足
          </div>
        </Form.Item>

        <Form.Item label="Tile 填充">
          <InputNumber
            value={params.tilePad}
            onChange={(value) => updateParams({ tilePad: value || 10 })}
            min={0}
            max={50}
            style={{ width: '100%' }}
          />
        </Form.Item>

        <Form.Item label="Pre 填充">
          <InputNumber
            value={params.prePad}
            onChange={(value) => updateParams({ prePad: value || 0 })}
            min={0}
            max={50}
            style={{ width: '100%' }}
          />
        </Form.Item>

        <Divider />

        <Form.Item label="高级选项">
          <Space direction="vertical" style={{ width: '100%' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span>人脸增强 (GFPGAN)</span>
              <Switch
                checked={params.faceEnhance}
                onChange={(checked) => updateParams({ faceEnhance: checked })}
              />
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span>FP32 精度模式</span>
              <Switch
                checked={params.fp32}
                onChange={(checked) => updateParams({ fp32: checked })}
              />
              <div style={{ fontSize: 12, color: '#999' }}>
                FP16 更快，FP32 更精确
              </div>
            </div>
          </Space>
        </Form.Item>
      </Form>
    </Card>
  )
}

export default ParameterPanel

