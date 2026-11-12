# Qwen model benchmark

This branch contains a temporary, isolated coding fixture used to compare the current Qwen2.5-Coder-7B model with Qwen3.5-9B. The comparison workflow runs both models on the same task and validates each patch independently. It does not change the production model or publish generated patches.

The push-trigger file is intentionally touched after the benchmark workflow is merged into the default branch.

Benchmark trigger: 2026-11-12 rerun after JSON and empty-patch recovery fixes.
