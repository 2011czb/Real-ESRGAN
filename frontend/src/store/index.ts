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
  params: ProcessingParams
  setOriginalImage: (image: string | null) => void
  setResultImage: (image: string | null) => void
  setProcessingTime: (time: number | null) => void
  updateParams: (params: Partial<ProcessingParams>) => void
}

export const useAppStore = create<AppState>((set) => ({
  originalImage: null,
  resultImage: null,
  processingTime: null,
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
  updateParams: (newParams) =>
    set((state) => ({
      params: { ...state.params, ...newParams },
    })),
}))

