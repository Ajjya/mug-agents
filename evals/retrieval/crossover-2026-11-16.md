Synthetic, no embedding model: random unit vectors, 768 dimensions, stored exactly as the stores keep chunks (BSON array of float64). 20 random query vectors per size after one warm-up, `vector` strategy, limit 5, public scope, gates open. Brute force: local mongod (`MONGODB_URI`), similarity in Node. Atlas: mongodb-atlas-local 9.0.4, `$vectorSearch` dotProduct, quantization none, numCandidates 1000. Each size is loaded, measured and dropped one store at a time. p95 over 20 samples is a rough figure. Random vectors are the worst case for an ANN index (no cluster structure), so the recall column is a floor.

| Chunks | brute force median | brute force p95 | Atlas median | Atlas p95 | Atlas recall@5 vs exact | load (brute force / Atlas) | Atlas index build |
|---|---|---|---|---|---|---|---|
| 100 | 3.9 ms | 8.2 ms | 12.1 ms | 13.9 ms | 1.00 | 69.6 ms / 89.9 ms | 2.20 s |
| 300 | 11.1 ms | 20.7 ms | 11.7 ms | 15.2 ms | 1.00 | 66.1 ms / 231.6 ms | 2.14 s |
| 1,000 | 37.2 ms | 41.3 ms | 13.7 ms | 17.7 ms | 1.00 | 154.2 ms / 643.6 ms | 4.22 s |
| 3,000 | 117.0 ms | 157.2 ms | 12.0 ms | 17.0 ms | 1.00 | 377.9 ms / 2.11 s | 4.19 s |
| 10,000 | 448.3 ms | 510.0 ms | 28.2 ms | 60.8 ms | 1.00 | 1.14 s / 6.42 s | 8.70 s |
| 30,000 | 1.74 s | 2.12 s | 22.5 ms | 33.4 ms | 0.99 | 3.21 s / 17.86 s | 10.54 s |
| 100,000 | 9.93 s | 11.14 s | 98.2 ms | 222.8 ms | 0.95 | 11.68 s / 46.26 s | 39.29 s |
| 1,000,000 | - | - | - | - | - | - / - | - |

**Not run:**

- 1,000,000, brute force: not run: needs ~9.7 GB on disk, 14.0 GB free (keeping 10.0 GB headroom).
- 1,000,000, Atlas: not run: needs ~15.4 GB on disk (documents + vector index), 14.0 GB free (keeping 10.0 GB headroom).

**Crossover (median latency):** between 300 and 1,000 chunks; interpolated on log size and log latency ratio, about **320 chunks** (at 300 the two medians are within 1 ms).
