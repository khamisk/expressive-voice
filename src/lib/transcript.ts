export function formatTranscript(transcript: string): string {
  return transcript
    .replace(/\s*[—–]\s*/g, ", ")
    .replace(/,{2,}/g, ",")
    .replace(/([!?])(?=\p{L})/gu, "$1 ")
    .replace(/(\p{Ll}\.)(?=\p{Lu})/gu, "$1 ")
    .replace(/\s+([,.;!?])/g, "$1");
}
