import React, { useCallback, useEffect, useState } from 'react'
import { Layout, ConfigProvider, theme, message } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import Header from './components/Header'
import ImageUploader from './components/ImageUploader'
import ParameterPanel from './components/ParameterPanel'
import ResultDisplay from './components/ResultDisplay'
import ProcessingService from './services/ProcessingService'
import './App.css'

const { Content } = Layout

const App: React.FC = () => {
  const [processingMode, setProcessingMode] = useState<'local' | 'cloud'>('local')
  const [isDarkMode, setIsDarkMode] = useState(false)

  const localService = useState(() => new ProcessingService('http://localhost:8000'))[0]
  const cloudService = useState(() => new ProcessingService('http://119.8.52.74:8080'))[0]
  const currentService = processingMode === 'local' ? localService : cloudService

  useEffect(() => {
    const service = processingMode === 'local' ? localService : cloudService
    service.setMode(processingMode)
  }, [processingMode, localService, cloudService])

  const handleModeChange = useCallback(async (mode: 'local' | 'cloud') => {
    const targetService = mode === 'local' ? localService : cloudService

    if (mode === 'cloud') {
      setProcessingMode('cloud')
      const hide = message.loading('正在检测云端连通性...', 0)
      try {
        const result = await targetService.testConnectivity()
        hide()
        if (result.ok) {
          message.success(result.message || '云端服务可用')
          targetService.setMode('cloud')
        } else {
          message.error(`云端服务不可用：${result.message}`)
          setProcessingMode('local')
          localService.setMode('local')
        }
      } catch (error: any) {
        hide()
        message.error(error?.message || '云端连通性测试失败')
        setProcessingMode('local')
        localService.setMode('local')
      }
    } else {
      setProcessingMode('local')
      localService.setMode('local')
      message.success('已切换到本地模式')
    }
  }, [cloudService, localService])

  return (
    <ConfigProvider
      locale={zhCN}
      theme={{
        algorithm: isDarkMode ? theme.darkAlgorithm : theme.defaultAlgorithm,
      }}
    >
      <Layout className="app-layout">
        <Header
          processingMode={processingMode}
          onModeChange={handleModeChange}
          isDarkMode={isDarkMode}
          onThemeChange={setIsDarkMode}
        />
        <Content className="app-content">
          <div className="main-container">
            <div className="left-panel">
              <ImageUploader processingService={currentService} />
            </div>
            <div className="right-panel">
              <ParameterPanel />
            </div>
          </div>
          <div className="result-panel">
            <ResultDisplay />
          </div>
        </Content>
      </Layout>
    </ConfigProvider>
  )
}

export default App

