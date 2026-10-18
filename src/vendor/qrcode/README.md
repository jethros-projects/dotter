# QR encoder

Local copy of Kazuhiko Arase's MIT-licensed QRCode JavaScript encoder, supplied by the installed npm `qrcode-terminal` package. It runs entirely on the local CLI host; no image service receives sign-in codes.

Only CommonJS filenames/import references were changed from `.js` to `.cjs` for this package's ES module layout. See `LICENSE` for the original license. The caller converts text to UTF-8 bytes before encoding and renders vector geometry without copying the payload into SVG text or attributes.
