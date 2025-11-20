"""
Real-ESRGAN API Server
支持本地模型推理和云端接口切换
"""
import asyncio
import base64
import io
import json
import os
import signal
import sys
import time
import uuid
from typing import Optional

import cv2
import numpy as np
import torch
from fastapi import FastAPI, File, UploadFile, WebSocket, WebSocketDisconnect, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from basicsr.archs.rrdbnet_arch import RRDBNet
from basicsr.utils.download_util import load_file_from_url
from realesrgan import RealESRGANer
from realesrgan.archs.srvgg_arch import SRVGGNetCompact

app = FastAPI(title="Real-ESRGAN API Server", version="1.0.0")

# CORS配置
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # 开发环境，生产环境应限制具体域名
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# 全局变量
upsampler_cache = {}
processing_tasks = {}
# 任务取消标志：{task_id: cancelled_flag}
task_cancelled = {}
# 服务器关闭标志
server_shutting_down = False
# 活跃的WebSocket连接
active_websockets = set()


class EnhanceRequest(BaseModel):
    """图像增强请求模型"""
    model_name: str = "RealESRGAN_x4plus"
    scale: float = 4.0
    tile: int = 0
    tile_pad: int = 10
    pre_pad: int = 0
    face_enhance: bool = False
    fp32: bool = False
    outscale: Optional[float] = None
    processing_mode: str = "local"  # local 或 cloud


class ProcessingService:
    """处理服务类，支持本地和云端切换"""

    def __init__(self):
        self.mode = "local"  # local 或 cloud
        self.cloud_endpoints = {
            "preprocessing": None,
            "inference": None,
            "postprocessing": None,
            "face_enhancement": None
        }

    def set_mode(self, mode: str):
        """设置处理模式"""
        if mode not in ["local", "cloud"]:
            raise ValueError("mode must be 'local' or 'cloud'")
        self.mode = mode

    def set_cloud_endpoints(self, endpoints: dict):
        """设置云端接口地址"""
        self.cloud_endpoints.update(endpoints)

    def _get_device_info(self):
        """获取设备信息"""
        if torch.cuda.is_available():
            device_name = torch.cuda.get_device_name(0)
            memory_total = torch.cuda.get_device_properties(0).total_memory / 1024**3  # GB
            memory_allocated = torch.cuda.memory_allocated(0) / 1024**3  # GB
            return {
                "device": "GPU",
                "device_name": device_name,
                "memory_total_gb": round(memory_total, 2),
                "memory_allocated_gb": round(memory_allocated, 2),
                "memory_free_gb": round(memory_total - memory_allocated, 2)
            }
        else:
            return {
                "device": "CPU",
                "device_name": "CPU",
                "memory_total_gb": None,
                "memory_allocated_gb": None,
                "memory_free_gb": None
            }

    def _calculate_auto_tile(self, img_height: int, img_width: int, scale: float = 4.0):
        """根据图像大小自动计算tile大小"""
        # 估算输出图像大小
        output_height = int(img_height * scale)
        output_width = int(img_width * scale)

        # 估算所需内存（粗略计算，假设每个像素4字节）
        estimated_memory_mb = (output_height * output_width * 4) / (1024 * 1024)

        # 如果使用GPU，检查可用内存
        if torch.cuda.is_available():
            memory_free_gb = (torch.cuda.get_device_properties(0).total_memory -
                            torch.cuda.memory_allocated(0)) / 1024**3
            memory_free_mb = memory_free_gb * 1024

            # 如果估算内存超过可用内存的60%，启用tile
            if estimated_memory_mb > memory_free_mb * 0.6:
                # 根据可用内存计算合适的tile大小
                if memory_free_mb < 2000:  # 小于2GB
                    return 200
                elif memory_free_mb < 4000:  # 小于4GB
                    return 400
                elif memory_free_mb < 8000:  # 小于8GB
                    return 600
                else:
                    return 800
        else:
            # CPU模式，更保守的tile设置
            if estimated_memory_mb > 1000:  # 超过1GB
                return 400

        # 如果图像很大（超过2048像素），也启用tile
        if img_height > 2048 or img_width > 2048:
            return 400

        return 0  # 不需要tile

    def _clear_gpu_cache(self):
        """清理GPU缓存"""
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
            torch.cuda.synchronize()

    async def enhance_image_local(
        self,
        image_data: bytes,
        params: EnhanceRequest,
        progress_callback=None,
        task_id: Optional[str] = None,
        check_cancelled=None
    ):
        """本地处理图像"""
        # 检查服务器是否正在关闭
        if server_shutting_down:
            raise asyncio.CancelledError("服务器正在关闭")

        # 清理GPU缓存
        self._clear_gpu_cache()

        try:
            # 检查是否已取消
            if task_id and check_cancelled and check_cancelled():
                raise asyncio.CancelledError("任务已取消")
            # 解析图像
            nparr = np.frombuffer(image_data, np.uint8)
            img = cv2.imdecode(nparr, cv2.IMREAD_UNCHANGED)

            if img is None:
                raise ValueError("无法解析图像数据")

            img_height, img_width = img.shape[:2]

            # 检测图像模式
            if len(img.shape) == 3 and img.shape[2] == 4:
                img_mode = 'RGBA'
            else:
                img_mode = None

            # 自动调整tile大小（如果用户未设置或设置为0）
            actual_tile = params.tile
            if actual_tile == 0:
                auto_tile = self._calculate_auto_tile(img_height, img_width, params.scale)
                if auto_tile > 0:
                    actual_tile = auto_tile
                    if progress_callback:
                        await progress_callback(5, f"检测到大图像，自动启用分块处理 (tile={actual_tile})")

            # 获取设备信息
            device_info = self._get_device_info()
            if progress_callback:
                device_msg = f"使用{device_info['device']}"
                if device_info['device'] == 'GPU':
                    device_msg += f" ({device_info['device_name']}, 可用内存: {device_info['memory_free_gb']:.2f}GB)"
                await progress_callback(8, device_msg)

            # 获取或创建upsampler（使用实际的tile值）
            cache_key = f"{params.model_name}_{actual_tile}_{params.fp32}"
            upsampler = None

            # 尝试使用缓存的upsampler，但如果tile不同需要重新创建
            if cache_key in upsampler_cache:
                upsampler = upsampler_cache[cache_key]
            else:
                # 创建新的upsampler，使用实际的tile值
                params_with_tile = EnhanceRequest(
                    model_name=params.model_name,
                    scale=params.scale,
                    tile=actual_tile,
                    tile_pad=params.tile_pad,
                    pre_pad=params.pre_pad,
                    face_enhance=params.face_enhance,
                    fp32=params.fp32,
                    outscale=params.outscale,
                    processing_mode=params.processing_mode
                )
                upsampler = self._create_upsampler(params_with_tile)
                upsampler_cache[cache_key] = upsampler

            # 进度回调：开始处理
            if progress_callback:
                await progress_callback(10, "开始处理图像...")

            # 检查取消
            if task_id and check_cancelled and check_cancelled():
                raise asyncio.CancelledError("任务已取消")

            # 处理图像（带错误重试机制）
            max_retries = 2
            retry_count = 0
            output = None

            while retry_count <= max_retries:
                # 检查取消
                if task_id and check_cancelled and check_cancelled():
                    raise asyncio.CancelledError("任务已取消")

                try:
                    if params.face_enhance:
                        from gfpgan import GFPGANer
                        face_enhancer = GFPGANer(
                            model_path='https://github.com/TencentARC/GFPGAN/releases/download/v1.3.0/GFPGANv1.3.pth',
                            upscale=params.outscale or params.scale,
                            arch='clean',
                            channel_multiplier=2,
                            bg_upsampler=upsampler
                        )
                        if progress_callback:
                            await progress_callback(50, "正在进行人脸增强...")

                        # 检查取消
                        if task_id and check_cancelled and check_cancelled():
                            raise asyncio.CancelledError("任务已取消")

                        _, _, output = face_enhancer.enhance(
                            img, has_aligned=False, only_center_face=False, paste_back=True
                        )
                    else:
                        if progress_callback:
                            await progress_callback(30, "正在进行图像超分辨率处理...")

                        # 检查取消
                        if task_id and check_cancelled and check_cancelled():
                            raise asyncio.CancelledError("任务已取消")

                        output, _ = upsampler.enhance(img, outscale=params.outscale)

                    # 处理成功，跳出循环
                    break

                except RuntimeError as e:
                    error_msg = str(e)
                    # 检查是否是CUDA内存不足错误
                    if "CUDA out of memory" in error_msg or "out of memory" in error_msg.lower():
                        retry_count += 1

                        if retry_count <= max_retries:
                            # 清理GPU缓存
                            self._clear_gpu_cache()

                            # 减小tile大小重试
                            if actual_tile > 0:
                                actual_tile = max(200, actual_tile - 200)
                            else:
                                actual_tile = 400

                            # 重新创建upsampler
                            params_with_tile = EnhanceRequest(
                                model_name=params.model_name,
                                scale=params.scale,
                                tile=actual_tile,
                                tile_pad=params.tile_pad,
                                pre_pad=params.pre_pad,
                                face_enhance=params.face_enhance,
                                fp32=params.fp32,
                                outscale=params.outscale,
                                processing_mode=params.processing_mode
                            )

                            # 删除旧的upsampler缓存
                            if cache_key in upsampler_cache:
                                del upsampler_cache[cache_key]

                            upsampler = self._create_upsampler(params_with_tile)
                            cache_key = f"{params.model_name}_{actual_tile}_{params.fp32}"
                            upsampler_cache[cache_key] = upsampler

                            if progress_callback:
                                await progress_callback(25, f"内存不足，使用更小的tile重试 (tile={actual_tile})...")
                        else:
                            # 重试次数用完，抛出错误
                            raise HTTPException(
                                status_code=500,
                                detail=f"GPU内存不足，请尝试：1) 减小图像尺寸 2) 设置tile参数（建议400-800）3) 关闭其他占用GPU的程序"
                            )
                    else:
                        # 其他运行时错误，直接抛出
                        raise
                except Exception as e:
                    # 其他异常，直接抛出
                    raise HTTPException(status_code=500, detail=f"处理失败: {str(e)}")

            if output is None:
                raise HTTPException(status_code=500, detail="处理失败：未生成输出")

            if progress_callback:
                await progress_callback(90, "处理完成，正在编码结果...")

            # 清理GPU缓存
            self._clear_gpu_cache()

            # 编码结果
            if img_mode == 'RGBA':
                encode_param = [cv2.IMWRITE_PNG_COMPRESSION, 9]
                result, encoded_img = cv2.imencode('.png', output, encode_param)
            else:
                encode_param = [cv2.IMWRITE_JPEG_QUALITY, 95]
                result, encoded_img = cv2.imencode('.jpg', output, encode_param)

            if not result:
                raise ValueError("图像编码失败")

            if progress_callback:
                await progress_callback(100, "处理完成！")

            return encoded_img.tobytes(), img_mode

        except asyncio.CancelledError:
            # 任务被取消
            self._clear_gpu_cache()
            if task_id and task_id in task_cancelled:
                del task_cancelled[task_id]
            raise
        except HTTPException:
            # 重新抛出HTTP异常
            raise
        except Exception as e:
            # 清理GPU缓存
            self._clear_gpu_cache()
            if task_id and task_id in task_cancelled:
                del task_cancelled[task_id]
            raise HTTPException(status_code=500, detail=f"处理失败: {str(e)}")

    async def enhance_image_cloud(
        self,
        image_data: bytes,
        params: EnhanceRequest,
        progress_callback=None
    ):
        """云端处理图像（当前复用本地处理逻辑）"""
        # 当前部署场景下，"云端" 模式表示：前端通过公网IP访问本服务，
        # 实际推理仍由本机执行，因此这里直接调用本地处理实现。
        result_data, img_mode = await self.enhance_image_local(
            image_data,
            params,
            progress_callback,
            task_id=None,
            check_cancelled=None,
        )
        return result_data, img_mode

    def _create_upsampler(self, params: EnhanceRequest):
        """创建upsampler实例"""
        model_name = params.model_name.split('.')[0]

        # 根据模型名称确定架构
        if model_name == 'RealESRGAN_x4plus':
            model = RRDBNet(num_in_ch=3, num_out_ch=3, num_feat=64, num_block=23, num_grow_ch=32, scale=4)
            netscale = 4
            file_url = ['https://github.com/xinntao/Real-ESRGAN/releases/download/v0.1.0/RealESRGAN_x4plus.pth']
        elif model_name == 'RealESRNet_x4plus':
            model = RRDBNet(num_in_ch=3, num_out_ch=3, num_feat=64, num_block=23, num_grow_ch=32, scale=4)
            netscale = 4
            file_url = ['https://github.com/xinntao/Real-ESRGAN/releases/download/v0.1.1/RealESRNet_x4plus.pth']
        elif model_name == 'RealESRGAN_x4plus_anime_6B':
            model = RRDBNet(num_in_ch=3, num_out_ch=3, num_feat=64, num_block=6, num_grow_ch=32, scale=4)
            netscale = 4
            file_url = ['https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.2.4/RealESRGAN_x4plus_anime_6B.pth']
        elif model_name == 'RealESRGAN_x2plus':
            model = RRDBNet(num_in_ch=3, num_out_ch=3, num_feat=64, num_block=23, num_grow_ch=32, scale=2)
            netscale = 2
            file_url = ['https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.1/RealESRGAN_x2plus.pth']
        elif model_name == 'realesr-animevideov3':
            model = SRVGGNetCompact(num_in_ch=3, num_out_ch=3, num_feat=64, num_conv=16, upscale=4, act_type='prelu')
            netscale = 4
            file_url = ['https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.5.0/realesr-animevideov3.pth']
        elif model_name == 'realesr-general-x4v3':
            model = SRVGGNetCompact(num_in_ch=3, num_out_ch=3, num_feat=64, num_conv=32, upscale=4, act_type='prelu')
            netscale = 4
            file_url = [
                'https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.5.0/realesr-general-wdn-x4v3.pth',
                'https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.5.0/realesr-general-x4v3.pth'
            ]
        else:
            raise ValueError(f"不支持的模型: {model_name}")

        # 确定模型路径
        model_path = os.path.join('weights', model_name + '.pth')
        if not os.path.isfile(model_path):
            ROOT_DIR = os.path.dirname(os.path.abspath(__file__))
            for url in file_url:
                model_path = load_file_from_url(
                    url=url, model_dir=os.path.join(ROOT_DIR, 'weights'), progress=True, file_name=None
                )

        # 处理DNI权重
        dni_weight = None
        if model_name == 'realesr-general-x4v3':
            wdn_model_path = model_path.replace('realesr-general-x4v3', 'realesr-general-wdn-x4v3')
            model_path = [model_path, wdn_model_path]
            dni_weight = [0.5, 0.5]  # 默认去噪强度

        # 确定使用的设备
        # gpu_id=None 表示自动选择：如果有GPU就用GPU，否则用CPU
        # RealESRGANer会自动检测CUDA可用性
        use_gpu = torch.cuda.is_available()
        gpu_id = 0 if use_gpu else None

        # 创建upsampler
        upsampler = RealESRGANer(
            scale=netscale,
            model_path=model_path,
            dni_weight=dni_weight,
            model=model,
            tile=params.tile,
            tile_pad=params.tile_pad,
            pre_pad=params.pre_pad,
            half=not params.fp32,
            gpu_id=gpu_id  # 自动选择GPU或CPU
        )

        return upsampler


# 创建处理服务实例
processing_service = ProcessingService()


def cleanup_resources():
    """清理所有资源"""
    global server_shutting_down, task_cancelled, upsampler_cache, active_websockets

    print("\n正在清理资源...")
    server_shutting_down = True

    # 1. 标记所有任务为取消
    for task_id in list(task_cancelled.keys()):
        task_cancelled[task_id] = True

    # 2. 关闭所有活跃的WebSocket连接（异步方式）
    if active_websockets:
        try:
            loop = asyncio.get_event_loop()
            if loop.is_running():
                # 如果事件循环正在运行，创建任务关闭连接
                for ws in list(active_websockets):
                    try:
                        asyncio.create_task(ws.close())
                    except Exception as e:
                        print(f"关闭WebSocket连接时出错: {e}")
            else:
                # 如果事件循环未运行，直接运行
                async def close_all():
                    for ws in list(active_websockets):
                        try:
                            await ws.close()
                        except:
                            pass
                loop.run_until_complete(close_all())
        except Exception as e:
            print(f"关闭WebSocket连接时出错: {e}")

    # 3. 清理GPU缓存
    if torch.cuda.is_available():
        print("清理GPU缓存...")
        try:
            torch.cuda.empty_cache()
            torch.cuda.synchronize()
            print("GPU内存已清理")
        except Exception as e:
            print(f"清理GPU缓存时出错: {e}")

    # 4. 清理模型缓存（可选，如果需要释放更多内存）
    # 注意：清理模型缓存会释放已加载的模型，下次使用时需要重新加载
    # upsampler_cache.clear()
    # print("模型缓存已清理")

    # 5. 清理任务标志
    task_cancelled.clear()
    active_websockets.clear()

    print("资源清理完成")


def signal_handler(signum, frame):
    """信号处理器"""
    print(f"\n收到信号 {signum}，开始优雅关闭...")
    cleanup_resources()
    sys.exit(0)


# 注册信号处理器（Windows可能不支持SIGTERM）
try:
    signal.signal(signal.SIGINT, signal_handler)
except (AttributeError, ValueError):
    pass  # Windows可能不支持

try:
    signal.signal(signal.SIGTERM, signal_handler)
except (AttributeError, ValueError):
    pass  # Windows可能不支持


@app.get("/")
async def root():
    """根路径"""
    return {
        "message": "Real-ESRGAN API Server",
        "version": "1.0.0",
        "status": "running"
    }


@app.get("/api/health")
async def health_check():
    """健康检查"""
    device_info = processing_service._get_device_info()
    return {
        "status": "healthy",
        "mode": processing_service.mode,
        "device": device_info
    }


@app.post("/api/v1/enhance")
async def enhance_image(
    file: UploadFile = File(...),
    model_name: str = "RealESRGAN_x4plus",
    scale: float = 4.0,
    tile: int = 0,
    tile_pad: int = 10,
    pre_pad: int = 0,
    face_enhance: bool = False,
    fp32: bool = False,
    outscale: Optional[float] = None,
    processing_mode: str = "local"
):
    """图像增强接口（同步）"""
    # 验证文件类型
    if not file.content_type or not file.content_type.startswith('image/'):
        raise HTTPException(status_code=400, detail="文件必须是图像格式")

    # 读取文件
    image_data = await file.read()

    # 创建请求参数
    params = EnhanceRequest(
        model_name=model_name,
        scale=scale,
        tile=tile,
        tile_pad=tile_pad,
        pre_pad=pre_pad,
        face_enhance=face_enhance,
        fp32=fp32,
        outscale=outscale,
        processing_mode=processing_mode
    )

    # 处理图像
    start_time = time.time()
    if processing_mode == "local":
        result_data, img_mode = await processing_service.enhance_image_local(image_data, params)
    else:
        result_data, img_mode = await processing_service.enhance_image_cloud(image_data, params)

    processing_time = time.time() - start_time

    # 返回结果
    result_base64 = base64.b64encode(result_data).decode('utf-8')

    return {
        "status": "success",
        "result_image": f"data:image/{'png' if img_mode == 'RGBA' else 'jpeg'};base64,{result_base64}",
        "processing_time": round(processing_time, 2),
        "image_mode": img_mode or "RGB"
    }


@app.websocket("/api/v1/enhance/stream")
async def enhance_image_stream(websocket: WebSocket):
    """图像增强接口（WebSocket实时进度）"""
    await websocket.accept()

    # 注册WebSocket连接
    active_websockets.add(websocket)

    task_id = str(uuid.uuid4())
    task_cancelled[task_id] = False
    await websocket.send_json({
        "type": "task",
        "task_id": task_id
    })

    def check_cancelled():
        # 检查服务器是否正在关闭
        if server_shutting_down:
            return True
        return task_cancelled.get(task_id, False)

    try:
        # 先接收初始请求（避免与receive_messages冲突）
        try:
            data = await asyncio.wait_for(websocket.receive_json(), timeout=30.0)
        except asyncio.TimeoutError:
            await websocket.send_json({"type": "error", "message": "请求超时"})
            if task_id in task_cancelled:
                del task_cancelled[task_id]
            return

        if data.get("type") != "start":
            await websocket.send_json({"type": "error", "message": "无效的请求类型"})
            if task_id in task_cancelled:
                del task_cancelled[task_id]
            return

        # 创建接收消息的任务（在接收初始请求之后）
        receive_task = None
        async def receive_messages():
            while True:
                try:
                    # 使用 receive_text 而不是 receive_json，避免冲突
                    message = await websocket.receive_text()
                    try:
                        data = json.loads(message)
                        if data.get("type") == "cancel":
                            task_cancelled[task_id] = True
                            await websocket.send_json({
                                "type": "cancelled",
                                "message": "任务已取消"
                            })
                            return
                    except json.JSONDecodeError:
                        # 忽略非JSON消息
                        pass
                except WebSocketDisconnect:
                    # 客户端断开，标记为取消
                    task_cancelled[task_id] = True
                    return
                except Exception as e:
                    # 如果连接已关闭，退出循环
                    if "disconnect" in str(e).lower() or "closed" in str(e).lower():
                        task_cancelled[task_id] = True
                        return
                    # 忽略其他错误，继续监听
                    pass

        # 启动接收消息任务（监听取消消息）
        receive_task = asyncio.create_task(receive_messages())

        # 解析参数
        image_base64 = data.get("image")
        if not image_base64:
            await websocket.send_json({"type": "error", "message": "缺少图像数据"})
            return

        # 解码图像
        image_data = base64.b64decode(image_base64.split(',')[1] if ',' in image_base64 else image_base64)

        # 创建请求参数
        params = EnhanceRequest(
            model_name=data.get("model_name", "RealESRGAN_x4plus"),
            scale=float(data.get("scale", 4.0)),
            tile=int(data.get("tile", 0)),
            tile_pad=int(data.get("tile_pad", 10)),
            pre_pad=int(data.get("pre_pad", 0)),
            face_enhance=bool(data.get("face_enhance", False)),
            fp32=bool(data.get("fp32", False)),
            outscale=float(data.get("outscale")) if data.get("outscale") else None,
            processing_mode=data.get("processing_mode", "local")
        )

        # 进度回调函数
        async def progress_callback(progress: int, message: str):
            # 检查是否已取消或服务器正在关闭
            if check_cancelled():
                raise asyncio.CancelledError("任务已取消")
            try:
                await websocket.send_json({
                    "type": "progress",
                    "progress": progress,
                    "message": message
                })
            except Exception:
                # 如果连接已关闭，停止发送
                raise asyncio.CancelledError("连接已断开")

        # 处理图像
        start_time = time.time()
        try:
            if params.processing_mode == "local":
                result_data, img_mode = await processing_service.enhance_image_local(
                    image_data, params, progress_callback, task_id, check_cancelled
                )
            else:
                result_data, img_mode = await processing_service.enhance_image_cloud(
                    image_data, params, progress_callback
                )

            # 检查是否在最后被取消
            if check_cancelled():
                raise asyncio.CancelledError("任务已取消")

            processing_time = time.time() - start_time

            # 编码结果
            result_base64 = base64.b64encode(result_data).decode('utf-8')

            # 发送结果
            await websocket.send_json({
                "type": "result",
                "result_image": f"data:image/{'png' if img_mode == 'RGBA' else 'jpeg'};base64,{result_base64}",
                "processing_time": round(processing_time, 2),
                "image_mode": img_mode or "RGB"
            })

        except asyncio.CancelledError:
            # 任务被取消
            processing_service._clear_gpu_cache()
            await websocket.send_json({
                "type": "cancelled",
                "message": "处理已取消，内存已清理"
            })
        finally:
            # 取消接收任务
            receive_task.cancel()
            try:
                await receive_task
            except asyncio.CancelledError:
                pass
            # 清理任务标志
            if task_id in task_cancelled:
                del task_cancelled[task_id]

    except WebSocketDisconnect:
        print("客户端断开连接")
        # 清理任务标志和GPU缓存
        if task_id in task_cancelled:
            del task_cancelled[task_id]
        processing_service._clear_gpu_cache()
    except Exception as e:
        try:
            await websocket.send_json({
                "type": "error",
                "message": str(e)
            })
        except:
            pass  # 如果连接已关闭，忽略发送错误
        # 清理任务标志
        if task_id in task_cancelled:
            del task_cancelled[task_id]
    finally:
        # 从活跃连接中移除
        active_websockets.discard(websocket)


@app.post("/api/v1/config/mode")
async def set_processing_mode(mode: str):
    """设置处理模式"""
    if mode not in ["local", "cloud"]:
        raise HTTPException(status_code=400, detail="mode must be 'local' or 'cloud'")
    processing_service.set_mode(mode)
    return {"status": "success", "mode": mode}


@app.get("/api/v1/config/mode")
async def get_processing_mode():
    """获取当前处理模式"""
    return {"mode": processing_service.mode}


@app.post("/api/v1/config/cloud-endpoints")
async def set_cloud_endpoints(endpoints: dict):
    """设置云端接口地址"""
    processing_service.set_cloud_endpoints(endpoints)
    return {"status": "success", "endpoints": processing_service.cloud_endpoints}


@app.get("/api/v1/ping")
async def ping():
    """连通性测试"""
    device_info = processing_service._get_device_info()
    return {
        "status": "ok",
        "mode": processing_service.mode,
        "device": device_info,
        "message": "云端服务在线，可接受任务"
    }


@app.post("/api/v1/tasks/{task_id}/cancel")
async def cancel_task(task_id: str):
    """通过HTTP请求取消任务"""
    existed = task_id in task_cancelled
    task_cancelled[task_id] = True
    return {
        "status": "success",
        "task_id": task_id,
        "cancelled": True,
        "message": "已通知服务器取消任务" if existed else "任务不存在或已完成，已忽略"
    }


if __name__ == "__main__":
    import uvicorn

    # 创建uvicorn配置，支持优雅关闭
    config = uvicorn.Config(
        app,
        host="0.0.0.0",
        port=8080,
        log_level="info"
    )

    server = uvicorn.Server(config)

    # 重写shutdown方法，确保清理资源
    original_shutdown = server.shutdown

    async def shutdown_with_cleanup():
        print("\n服务器正在关闭...")
        cleanup_resources()
        await original_shutdown()

    server.shutdown = shutdown_with_cleanup

    try:
        server.run()
    except KeyboardInterrupt:
        print("\n收到键盘中断信号")
        cleanup_resources()
    except Exception as e:
        print(f"\n服务器异常退出: {e}")
        cleanup_resources()
        raise

