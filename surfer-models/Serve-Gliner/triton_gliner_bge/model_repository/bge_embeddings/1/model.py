import numpy as np
import torch
import triton_python_backend_utils as pb_utils
from sentence_transformers import SentenceTransformer

QUERY_INSTRUCTION = "Represent this sentence for searching relevant passages: "


def decode_string(value):
    if isinstance(value, bytes):
        return value.decode("utf-8")
    return str(value)


class TritonPythonModel:
    def initialize(self, args):
        self.device = "cuda" if torch.cuda.is_available() else "cpu"
        self.model = SentenceTransformer("BAAI/bge-large-en-v1.5", device=self.device)
        print(f"[bge_embeddings] Loaded on device: {self.device}")

    def execute(self, requests):
        responses = []
        for request in requests:
            text_tensor = pb_utils.get_input_tensor_by_name(request, "text")
            is_query_tensor = pb_utils.get_input_tensor_by_name(request, "is_query")

            raw_texts = text_tensor.as_numpy().reshape(-1)
            raw_flags = is_query_tensor.as_numpy().reshape(-1)

            texts = []
            for text_raw, is_query_raw in zip(raw_texts, raw_flags):
                text = decode_string(text_raw)
                if bool(is_query_raw):
                    text = QUERY_INSTRUCTION + text
                texts.append(text)

            with torch.no_grad():
                embeddings = self.model.encode(
                    texts,
                    normalize_embeddings=True,
                    convert_to_numpy=True,
                    show_progress_bar=False,
                    batch_size=max(1, len(texts)),
                ).astype(np.float32)

            out = pb_utils.Tensor("embeddings", embeddings)
            responses.append(pb_utils.InferenceResponse(output_tensors=[out]))

        return responses

    def finalize(self):
        print("[bge_embeddings] Finalized")
