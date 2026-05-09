export function encodeWav(audioBuffer: Buffer, sampleRate: number) {
  const bytesPerSample = 2
  const blockAlign = bytesPerSample
  const byteRate = sampleRate * blockAlign
  const wavBuffer = Buffer.alloc(44 + audioBuffer.length)

  wavBuffer.write("RIFF", 0)
  wavBuffer.writeUInt32LE(36 + audioBuffer.length, 4)
  wavBuffer.write("WAVE", 8)
  wavBuffer.write("fmt ", 12)
  wavBuffer.writeUInt32LE(16, 16)
  wavBuffer.writeUInt16LE(1, 20)
  wavBuffer.writeUInt16LE(1, 22)
  wavBuffer.writeUInt32LE(sampleRate, 24)
  wavBuffer.writeUInt32LE(byteRate, 28)
  wavBuffer.writeUInt16LE(blockAlign, 32)
  wavBuffer.writeUInt16LE(16, 34)
  wavBuffer.write("data", 36)
  wavBuffer.writeUInt32LE(audioBuffer.length, 40)
  audioBuffer.copy(wavBuffer, 44)

  return wavBuffer
}
