import React from 'react'
import { Layout, Switch, Radio, Space, Typography } from 'antd'
import { BulbOutlined, BulbFilled } from '@ant-design/icons'

const { Header: AntHeader } = Layout
const { Title } = Typography

interface HeaderProps {
  processingMode: 'local' | 'cloud'
  onModeChange: (mode: 'local' | 'cloud') => void
  isDarkMode: boolean
  onThemeChange: (dark: boolean) => void
}

const Header: React.FC<HeaderProps> = ({
  processingMode,
  onModeChange,
  isDarkMode,
  onThemeChange,
}) => {
  return (
    <AntHeader
      style={{
        background: isDarkMode ? '#001529' : '#fff',
        padding: '0 24px',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        boxShadow: '0 2px 8px rgba(0, 0, 0, 0.1)',
      }}
    >
      <Title level={3} style={{ margin: 0, color: isDarkMode ? '#fff' : '#000' }}>
        Real-ESRGAN 图像修复工具
      </Title>
      <Space size="large">
        <Space>
          <span style={{ color: isDarkMode ? '#fff' : '#000' }}>处理模式：</span>
          <Radio.Group
            value={processingMode}
            onChange={(e) => onModeChange(e.target.value)}
            buttonStyle="solid"
          >
            <Radio.Button value="local">本地处理</Radio.Button>
            <Radio.Button value="cloud">云端处理</Radio.Button>
          </Radio.Group>
        </Space>
        <Space>
          {isDarkMode ? <BulbFilled /> : <BulbOutlined />}
          <Switch
            checked={isDarkMode}
            onChange={onThemeChange}
            checkedChildren="暗色"
            unCheckedChildren="亮色"
          />
        </Space>
      </Space>
    </AntHeader>
  )
}

export default Header

