import { create } from 'zustand'

interface ProcessingParams {
  modelName: string
  scale: number
  tile: number
  tilePad: number
  prePad: number
  faceEnhance: boolean
  fp32: boolean
  outscale: number
}

interface AppState {
  originalImage: string | null
  resultImage: string | null
  processingTime: number | null
  // 端到端耗时（从点击处理到结果显示），单位：秒
  endToEndTime: number | null
  // 后端处理耗时（后端返回的 processing_time），单位：秒
  backendProcessingTime: number | null
  // 是否启用在线无参考质量评估
  nrQualityEnabled: boolean
  // 在线无参考质量评估得分（0-100，数值越大代表估计质量越高）
  nrQualityScore: number | null
  // 上传/下载字节数
  inputSizeBytes: number | null
  outputSizeBytes: number | null
  // 资源占用（粗粒度）
  cpuPercent: number | null
  processMemMb: number | null
  gpuMemAllocatedMb: number | null
  gpuMemReservedMb: number | null
  // 前端压缩配置
  compressionEnabled: boolean
  compressionType: 'lossy' | 'lossless'
  compressionQuality: number // 0-1 之间
  // 网络条件配置（用于后端网络延迟模拟，仅对 HTTP 同步接口生效）
  networkProfile: 'none' | 'low' | 'medium' | 'high'
  // 传输协议：WebSocket 实时推送 / HTTP 同步
  transportProtocol: 'ws' | 'http'
  params: ProcessingParams
  setOriginalImage: (image: string | null) => void
  setResultImage: (image: string | null) => void
  setProcessingTime: (time: number | null) => void
  setEndToEndTime: (time: number | null) => void
  setBackendProcessingTime: (time: number | null) => void
  setNrQualityEnabled: (enabled: boolean) => void
  setNrQualityScore: (score: number | null) => void
  setInputSizeBytes: (bytes: number | null) => void
  setOutputSizeBytes: (bytes: number | null) => void
  setCpuPercent: (value: number | null) => void
  setProcessMemMb: (value: number | null) => void
  setGpuMemAllocatedMb: (value: number | null) => void
  setGpuMemReservedMb: (value: number | null) => void
  setNetworkProfile: (profile: 'none' | 'low' | 'medium' | 'high') => void
  setTransportProtocol: (protocol: 'ws' | 'http') => void
  updateCompression: (config: Partial<Pick<AppState, 'compressionEnabled' | 'compressionType' | 'compressionQuality'>>) => void
  updateParams: (params: Partial<ProcessingParams>) => void
}

export const useAppStore = create<AppState>((set) => ({
  originalImage: null,
  resultImage: null,
  processingTime: null,
  endToEndTime: null,
  backendProcessingTime: null,
  nrQualityEnabled: false,
  nrQualityScore: null,
  inputSizeBytes: null,
  outputSizeBytes: null,
  cpuPercent: null,
  processMemMb: null,
  gpuMemAllocatedMb: null,
  gpuMemReservedMb: null,
  compressionEnabled: false,
  compressionType: 'lossy',
  compressionQuality: 0.8,
  networkProfile: 'none',
  transportProtocol: 'ws',
  params: {
    modelName: 'RealESRGAN_x4plus',
    scale: 4.0,
    tile: 0,
    tilePad: 10,
    prePad: 0,
    faceEnhance: false,
    fp32: false,
    outscale: 4.0,
  },
  setOriginalImage: (image) => set({ originalImage: image }),
  setResultImage: (image) => set({ resultImage: image }),
  setProcessingTime: (time) => set({ processingTime: time }),
  setEndToEndTime: (time) => set({ endToEndTime: time }),
  setBackendProcessingTime: (time) => set({ backendProcessingTime: time }),
  setNrQualityEnabled: (enabled) => set({ nrQualityEnabled: enabled }),
  setNrQualityScore: (score) => set({ nrQualityScore: score }),
  setInputSizeBytes: (bytes) => set({ inputSizeBytes: bytes }),
  setOutputSizeBytes: (bytes) => set({ outputSizeBytes: bytes }),
  setCpuPercent: (value) => set({ cpuPercent: value }),
  setProcessMemMb: (value) => set({ processMemMb: value }),
  setGpuMemAllocatedMb: (value) => set({ gpuMemAllocatedMb: value }),
  setGpuMemReservedMb: (value) => set({ gpuMemReservedMb: value }),
  setNetworkProfile: (profile) => set({ networkProfile: profile }),
  setTransportProtocol: (protocol) => set({ transportProtocol: protocol }),
  updateCompression: (config) =>
    set((state) => ({
      compressionEnabled: config.compressionEnabled ?? state.compressionEnabled,
      compressionType: config.compressionType ?? state.compressionType,
      compressionQuality: config.compressionQuality ?? state.compressionQuality,
    })),
  updateParams: (newParams) =>
    set((state) => ({
      params: { ...state.params, ...newParams },
    })),
}))

