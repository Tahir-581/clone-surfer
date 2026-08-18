#!/usr/bin/env python3
"""
Async stress test for Triton model `gliner_ner`.
Schedules many HTTP inferences concurrently with a bounded semaphore.

  pip install 'tritonclient[http]' numpy
  python stress_gliner_ner.py --url localhost:8010 --requests 1000 --concurrency 64
"""

from __future__ import annotations

import argparse
import asyncio
import json
import statistics
import time
from typing import Any

import numpy as np
import tritonclient.http.aio as httpclient


LABELS = ["organization", "person", "location"]
BASE_TEXT = (
    "Apple Inc. was founded by Steve Jobs in Cupertino, California. "
    "Request index: {i}."
)


def decode_bytes(value: Any) -> str:
    if isinstance(value, bytes):
        return value.decode("utf-8")
    return str(value)


async def one_infer(
    client: httpclient.InferenceServerClient,
    idx: int,
    threshold: float,
) -> tuple[int, float, str | None]:
    text = BASE_TEXT.format(i=idx)
    text_np = np.array([[text]], dtype=object)
    labels_np = np.array([[json.dumps(LABELS)]], dtype=object)
    threshold_np = np.array([[threshold]], dtype=np.float32)

    inputs = [
        httpclient.InferInput("text", text_np.shape, "BYTES"),
        httpclient.InferInput("labels", labels_np.shape, "BYTES"),
        httpclient.InferInput("threshold", threshold_np.shape, "FP32"),
    ]
    inputs[0].set_data_from_numpy(text_np)
    inputs[1].set_data_from_numpy(labels_np)
    inputs[2].set_data_from_numpy(threshold_np)

    outputs = [httpclient.InferRequestedOutput("entities")]
    t0 = time.perf_counter()
    try:
        resp = await client.infer(
            model_name="gliner_ner",
            inputs=inputs,
            outputs=outputs,
            request_id=str(idx),
        )
        raw = resp.as_numpy("entities").reshape(-1)[0]
        _entities = json.loads(decode_bytes(raw))
        return idx, time.perf_counter() - t0, None
    except Exception as exc:  # noqa: BLE001
        return idx, time.perf_counter() - t0, str(exc)


async def run_all(
    url: str,
    n_requests: int,
    concurrency: int,
    threshold: float,
) -> None:
    sem = asyncio.Semaphore(concurrency)
    client = httpclient.InferenceServerClient(
        url=url,
        conn_limit=max(256, concurrency * 2),
    )

    async def bounded(idx: int) -> tuple[int, float, str | None]:
        async with sem:
            return await one_infer(client, idx, threshold)

    try:
        wall0 = time.perf_counter()
        results = await asyncio.gather(
            *[bounded(i) for i in range(n_requests)],
        )
        wall_s = time.perf_counter() - wall0
    finally:
        await client.close()

    errors = [r for r in results if r[2] is not None]
    oks = [r for r in results if r[2] is None]
    latencies = [r[1] for r in oks]
    sum_latency_all = sum(r[1] for r in results)

    print(f"model=gliner_ner url={url} requests={n_requests} concurrency={concurrency}")
    print(f"success={len(oks)} errors={len(errors)} wall_time_s={wall_s:.3f}")
    print(
        f"total_time_consumed_wall_s={wall_s:.3f}  "
        "(wall-clock from start until all requests finished)"
    )
    print(
        f"total_time_consumed_sum_request_latencies_s={sum_latency_all:.3f}  "
        "(sum of each request's round-trip time; can exceed wall time when concurrent)"
    )
    if latencies:
        print(
            "latency_s: "
            f"min={min(latencies):.4f} p50={statistics.median(latencies):.4f} "
            f"p95={_percentile(latencies, 95):.4f} max={max(latencies):.4f}"
        )
        print(f"throughput_rps={len(oks) / wall_s:.2f} (successful / wall)")
    if errors:
        print("first_errors:")
        for _, _, msg in errors[:5]:
            print(f"  {msg}")


def _percentile(sorted_or_seq: list[float], p: float) -> float:
    xs = sorted(sorted_or_seq)
    if not xs:
        return float("nan")
    k = (len(xs) - 1) * (p / 100.0)
    f = int(k)
    c = min(f + 1, len(xs) - 1)
    return xs[f] + (xs[c] - xs[f]) * (k - f)


def main() -> None:
    ap = argparse.ArgumentParser(description="Async stress test for gliner_ner on Triton HTTP.")
    ap.add_argument(
        "--url",
        default="localhost:8010",
        help="Triton HTTP host:port (no scheme), e.g. localhost:8010",
    )
    ap.add_argument("--requests", type=int, default=1000, help="Total inference calls.")
    ap.add_argument(
        "--concurrency",
        type=int,
        default=64,
        help="Max in-flight async requests at once.",
    )
    ap.add_argument("--threshold", type=float, default=0.5, help="GLiNER threshold input.")
    args = ap.parse_args()

    asyncio.run(
        run_all(
            url=args.url,
            n_requests=args.requests,
            concurrency=args.concurrency,
            threshold=args.threshold,
        )
    )


if __name__ == "__main__":
    main()
