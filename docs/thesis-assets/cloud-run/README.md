# Cloud Run pipeline figures

These screenshots document the deployment and smoke test completed on 28 July 2026 in Google Cloud project `tensile-yen-503711-d9` (`europe-west1`). They contain no API keys or crawler credentials.

| File | Suggested thesis caption | Use |
| --- | --- | --- |
| `02-cloud-run-jobs-success.png` | **Cloud Run job configuration for the distributed lost-property channel pipeline.** The crawler and merge stages are deployed as separate jobs in `europe-west1`; the latest executions completed successfully. | Chapter 5, deployment/operations |
| `03-crawl-execution-3-of-3-success.png` | **Three-way Cloud Run crawl smoke test.** All three parallel tasks completed with exit code 0 and without retries. | Chapter 6, performance and deployment validation |
| `04-merge-execution-success.png` | **Cloud Run merge and quality-audit stage.** The single merge task successfully combined the shard outputs and generated the candidate registry, scan report, quality report and run manifest. | Chapter 5 or Chapter 6 |
| `07-cloud-build-success.png` | **Reproducible container-image build for the crawler.** Cloud Build produced and published the Cloud Run image in 2 min 48 s. | Chapter 5, multi-environment build |
| `08-full-run-ops-dashboard.png` | **Operations dashboard after the full Berlin discovery run and reviewed-channel publication.** The dashboard reconciles the local crawl, review and publication artifacts with the public update feed; at capture time it reported 4,850 indexed venues, 1,496 candidates, 42 published channels and 148 reviewed venues. | Chapter 5, operations and maintainability |

`01-cloud-run-before-deployment.png` is retained only as a before-deployment record and is not recommended for the final thesis.

Smoke-test run: `smoke-20260728-1610`. Crawl execution: `lost-found-crawl-wxrt4`. Merge execution: `lost-found-merge-fxlw7`. The generated manifest reported three shard objects, 1,071 merged candidates, 186 completed scopes and `health.ok = true`.

Full run: `full-20260728-1625`. Crawl execution: `lost-found-crawl-zsfnx`. Merge execution: `lost-found-merge-d7v92`. Eight of eight crawl shards completed successfully. The merged manifest reported 1,496 candidates, 1,940 scanned venues, 537 venues with a discovered endpoint and `health.ok = true`. After evidence filtering and review, the published feed contained 42 channels covering 148 reviewed venues (dataset `97d7d8f41f334ad1`).
