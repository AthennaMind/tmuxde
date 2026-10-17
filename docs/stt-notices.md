# Speech release components

`tmuxde-stt` includes Parakeet TDT 0.6B v3 INT8 models and Silero VAD.
Models are downloaded during builds, embedded without further modification and
extracted to local cache at runtime. No runtime download occurs.

- Parakeet TDT 0.6B v3: NVIDIA, CC BY 4.0.
  [Original model](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3),
  [ONNX conversion by csukuangfj](https://huggingface.co/csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8),
  [license](https://creativecommons.org/licenses/by/4.0/).
- Silero VAD: Silero Team, MIT.
  [Source and license](https://github.com/snakers4/silero-vad),
  [ONNX distribution](https://huggingface.co/csukuangfj/vad).
- sherpa-onnx and kaldi-decoder: k2-fsa, Apache 2.0.
  [Source and license](https://github.com/k2-fsa/sherpa-onnx/tree/v1.13.8).
- ONNX Runtime: Microsoft, MIT.
  [Source and third-party notices](https://github.com/microsoft/onnxruntime/tree/v1.28.2).
- kaldi-native-fbank, kaldifst and OpenFST: Apache 2.0.
  [sherpa dependency recipes](https://github.com/k2-fsa/sherpa-onnx/tree/v1.13.8/cmake).
- SentencePiece: Google, Apache 2.0.
  [Source and license](https://github.com/google/sentencepiece).
- KissFFT: Mark Borgerding, BSD 3-Clause.
  [Source and license](https://github.com/mborgerding/kissfft).
- C and C++ runtime libraries come from build runner toolchain.
  GNU libc is LGPL 2.1 or later. GCC runtime libraries use GPL 3 with GCC
  Runtime Library Exception. [glibc source](https://sourceware.org/glibc/),
  [GCC source and runtime exception](https://gcc.gnu.org/onlinedocs/libstdc++/manual/license.html).

Pinned model, library and header URLs and SHA-256 checksums live in
`cmd/tmuxde-stt/assets.json`. Native preparation commands live directly in
`.github/workflows/release.yml`. ARM64 C API is rebuilt with speech synthesis
and speaker diarization disabled. `.goreleaser.yaml` defines static linking.
Root `Dockerfile` builds bundled binary from source in `tmuxde-stt` target;
`dev.Dockerfile` prepares libraries and models for hot reload.
