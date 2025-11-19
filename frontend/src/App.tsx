import React, { useState } from 'react'
import { Layout, ConfigProvider, theme } from 'antd'
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
  const [processingService] = useState(() => new ProcessingService())

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
          onModeChange={setProcessingMode}
          isDarkMode={isDarkMode}
          onThemeChange={setIsDarkMode}
        />
        <Content className="app-content">
          <div className="main-container">
            <div className="left-panel">
              <ImageUploader processingService={processingService} />
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

