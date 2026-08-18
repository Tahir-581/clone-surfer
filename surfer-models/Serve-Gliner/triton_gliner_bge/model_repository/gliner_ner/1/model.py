import json

import numpy as np
import torch
import triton_python_backend_utils as pb_utils
from gliner import GLiNER


def decode_string(value):
    if isinstance(value, bytes):
        return value.decode("utf-8")
    return str(value)


class TritonPythonModel:
    def initialize(self, args):
        self.device = "cuda" if torch.cuda.is_available() else "cpu"
        self.model = GLiNER.from_pretrained("urchade/gliner_large-v2.1")
        self.model.to(self.device)
        self.model.eval()
        print(f"[gliner_ner] Loaded on device: {self.device}")

    def execute(self, requests):
        responses = []
        for request in requests:
            text_tensor = pb_utils.get_input_tensor_by_name(request, "text")
            labels_tensor = pb_utils.get_input_tensor_by_name(request, "labels")
            threshold_tensor = pb_utils.get_input_tensor_by_name(request, "threshold")

            texts = text_tensor.as_numpy().reshape(-1)
            labels_list = labels_tensor.as_numpy().reshape(-1)
            thresholds = threshold_tensor.as_numpy().reshape(-1)

            batch_outputs = []
            for text_raw, labels_raw, threshold_raw in zip(texts, labels_list, thresholds):
                text = decode_string(text_raw)
                labels = json.loads(decode_string(labels_raw))
                threshold = float(threshold_raw)
                with torch.no_grad():
                    entities = self.model.predict_entities(text, labels, threshold=threshold)
                batch_outputs.append([json.dumps(entities, ensure_ascii=False)])

            out = pb_utils.Tensor("entities", np.array(batch_outputs, dtype=object))
            responses.append(pb_utils.InferenceResponse(output_tensors=[out]))

        return responses

    def finalize(self):
        print("[gliner_ner] Finalized")
