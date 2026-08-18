#!/usr/bin/env python3
"""
Async stress test for Triton model `bge_embeddings`.
Default: 1000 concurrent-scheduled HTTP inferences with bounded concurrency.

  pip install 'tritonclient[http]' numpy
  python stress_bge_embeddings.py --url localhost:8010 --requests 1000 --concurrency 64
"""

from __future__ import annotations

import argparse
import asyncio
import statistics
import time

import numpy as np
import tritonclient.http.aio as httpclient


def sample_text(i: int, as_query: bool) -> str:
    if as_query:
        return f"What is machine learning? variant={i}"
    return (
        f"NVIDIA Triton Inference Server serves models at scale. "
        f"Passage snippet index {i}."
    )


async def one_infer(
    client: httpclient.InferenceServerClient,
    idx: int,
    as_query: bool,
) -> tuple[int, float, str | None]:
    text = sample_text(idx, as_query)
    text_np = np.array([[text]], dtype=object)
    is_query_np = np.array([[as_query]], dtype=bool)

    inputs = [
        httpclient.InferInput("text", text_np.shape, "BYTES"),
        httpclient.InferInput("is_query", is_query_np.shape, "BOOL"),
    ]
    inputs[0].set_data_from_numpy(text_np)
    inputs[1].set_data_from_numpy(is_query_np)

    outputs = [httpclient.InferRequestedOutput("embeddings")]
    t0 = time.perf_counter()
    try:
        resp = await client.infer(
            model_name="bge_embeddings",
            inputs=inputs,
            outputs=outputs,
            request_id=str(idx),
        )
        emb = resp.as_numpy("embeddings")
        if emb.shape != (1, 1024):
            return idx, time.perf_counter() - t0, f"bad shape {emb.shape}"
        return idx, time.perf_counter() - t0, None
    except Exception as exc:  # noqa: BLE001
        return idx, time.perf_counter() - t0, str(exc)


async def run_all(
    url: str,
    n_requests: int,
    concurrency: int,
    query_every: int,
) -> None:
    """If query_every is 3, indices 0,3,6,... use is_query=True."""

    sem = asyncio.Semaphore(concurrency)
    client = httpclient.InferenceServerClient(
        url=url,
        conn_limit=max(256, concurrency * 2),
    )

    async def bounded(idx: int) -> tuple[int, float, str | None]:
        as_query = (idx % query_every) == 0
        async with sem:
            return await one_infer(client, idx, as_query)

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

    print(f"model=bge_embeddings url={url} requests={n_requests} concurrency={concurrency}")
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


def _percentile(xs: list[float], p: float) -> float:
    s = sorted(xs)
    if not s:
        return float("nan")
    k = (len(s) - 1) * (p / 100.0)
    f = int(k)
    c = min(f + 1, len(s) - 1)
    return s[f] + (s[c] - s[f]) * (k - f)


def main() -> None:
    ap = argparse.ArgumentParser(description="Async stress test for bge_embeddings on Triton HTTP.")
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
    ap.add_argument(
        "--query-every",
        type=int,
        default=3,
        metavar="N",
        help="Treat every Nth request index as a query (is_query=True).",
    )
    args = ap.parse_args()

    asyncio.run(
        run_all(
            url=args.url,
            n_requests=args.requests,
            concurrency=args.concurrency,
            query_every=max(1, args.query_every),
        )
    )


if __name__ == "__main__":
    main()
