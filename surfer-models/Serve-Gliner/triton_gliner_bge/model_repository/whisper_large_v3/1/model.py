import base64
import io
import os
import wave

import numpy as np
import torch
import triton_python_backend_utils as pb_utils
from transformers import AutoModelForSpeechSeq2Seq, AutoProcessor, pipeline

MODEL_ID = os.environ.get("WHISPER_MODEL_ID", "openai/whisper-large-v3")
DEFAULT_LANGUAGE = os.environ.get("WHISPER_DEFAULT_LANGUAGE", "")
DEFAULT_TASK = os.environ.get("WHISPER_DEFAULT_TASK", "transcribe")


def decode_string(value):
    if isinstance(value, bytes):
        return value.decode("utf-8")
    return str(value)


class TritonPythonModel:
    def initialize(self, args):
        # IMPORTANT: Triton may set CUDA_VISIBLE_DEVICES per model instance.
        # In that case, the "selected" physical GPU is exposed as cuda:0 inside this process.
        device_id = int(args.get("model_instance_device_id", 0))
        self.device = f"cuda:{device_id}" if torch.cuda.is_available() else "cpu"
        self.dtype = torch.float16 if self.device.startswith("cuda") else torch.float32

        self.processor = AutoProcessor.from_pretrained(MODEL_ID)
        self.model = AutoModelForSpeechSeq2Seq.from_pretrained(
            MODEL_ID,
            torch_dtype=self.dtype,
            low_cpu_mem_usage=True,
        )
        self.model.to(self.device)
        self.model.eval()

        self.asr = pipeline(
            task="automatic-speech-recognition",
            model=self.model,
            tokenizer=self.processor.tokenizer,
            feature_extractor=self.processor.feature_extractor,
            torch_dtype=self.dtype,
            device=device_id if self.device.startswith("cuda") else -1,
        )
        print(f"[whisper_large_v3] Loaded {MODEL_ID} on {self.device} ({self.dtype})")

    def execute(self, requests):
        responses = []
        for request in requests:
            audio_tensor = pb_utils.get_input_tensor_by_name(request, "audio_b64")
            task_tensor = pb_utils.get_input_tensor_by_name(request, "task")
            language_tensor = pb_utils.get_input_tensor_by_name(request, "language")

            audio_values = audio_tensor.as_numpy().reshape(-1)
            task_values = task_tensor.as_numpy().reshape(-1)
            language_values = language_tensor.as_numpy().reshape(-1)

            batch_texts = []
            for audio_b64_raw, task_raw, language_raw in zip(audio_values, task_values, language_values):
                audio_b64 = decode_string(audio_b64_raw).strip()
                task = decode_string(task_raw).strip() or DEFAULT_TASK
                language = decode_string(language_raw).strip() or DEFAULT_LANGUAGE

                if not audio_b64:
                    batch_texts.append("")
                    continue

                try:
                    audio_bytes = base64.b64decode(audio_b64, validate=True)
                except Exception as exc:
                    raise pb_utils.TritonModelException(f"Invalid base64 audio payload: {exc}") from exc

                try:
                    with wave.open(io.BytesIO(audio_bytes), "rb") as wav_file:
                        sample_rate = wav_file.getframerate()
                        channels = wav_file.getnchannels()
                        sample_width = wav_file.getsampwidth()
                        frames = wav_file.readframes(wav_file.getnframes())
                except Exception as exc:
                    raise pb_utils.TritonModelException(
                        f"Only base64-encoded WAV payload is supported right now: {exc}"
                    ) from exc

                if sample_width != 2:
                    raise pb_utils.TritonModelException(
                        f"Unsupported WAV sample width: {sample_width * 8} bits. Use PCM16 WAV."
                    )

                audio = np.frombuffer(frames, dtype=np.int16).astype(np.float32) / 32768.0
                if channels > 1:
                    audio = audio.reshape(-1, channels).mean(axis=1)

                generate_kwargs = {"task": task}
                if language:
                    generate_kwargs["language"] = language

                result = self.asr(
                    {"array": audio, "sampling_rate": sample_rate},
                    generate_kwargs=generate_kwargs,
                )
                batch_texts.append(result.get("text", "").strip())

            output = np.array([[text] for text in batch_texts], dtype=object)
            responses.append(
                pb_utils.InferenceResponse(
                    output_tensors=[pb_utils.Tensor("text", output)]
                )
            )
        return responses

    def finalize(self):
        print("[whisper_large_v3] Finalized")
