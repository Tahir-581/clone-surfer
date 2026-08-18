ARG TRITON_VERSION=24.12

FROM nvcr.io/nvidia/tritonserver:${TRITON_VERSION}-py3

RUN python3 -m pip install --no-cache-dir --upgrade setuptools wheel

# Install dependencies in-image to avoid Python backend env tar mismatch issues.
RUN python3 -m pip install --no-cache-dir \
    torch \
    --index-url https://download.pytorch.org/whl/cu124

RUN python3 -m pip install --no-cache-dir \
    numpy \
    transformers \
    sentence-transformers \
    accelerate \
    safetensors \
    gliner \
    tritonclient[http,grpc]
