# Hallway — iPhone-first Video Reverb

A Next.js app designed for iPhone Safari. It processes media in the browser: no app account, upload API, database, or server-side transcoding is used.

## What it does

- Select a video from iOS Photos or Files.
- Adjust reverb mix, decay time, hall size, and pre-delay.
- Extract the video's audio in FFmpeg WebAssembly, render a stereo reverb effect using Web Audio, then mux the new audio with the original video stream.
- Copy the video stream (`-c:v copy`) so video is not re-encoded; AAC-encode the new audio at 192 kbps.
- Download the MP4 or open the iOS share sheet when supported.

## Run locally

Requires Node.js 20.9+.

```bash
npm install
npm run dev
```

Open the local URL in a desktop browser for development. To test iPhone Safari, deploy to HTTPS or use a secure local tunnel.

## Deploy to Vercel for free

1. Create a GitHub repository and push this project.
2. In Vercel, choose **Add New → Project** and import the repository.
3. Keep the detected Next.js defaults and click **Deploy**.
4. Open the HTTPS deployment in iPhone Safari and optionally use **Share → Add to Home Screen**.

The Vercel Hobby plan is sufficient for hosting the static UI and Next.js page. No Vercel function is needed for media processing.

## iPhone/Safari notes

- Use a recent iOS version and Safari. Test with short clips first; browser memory and WebAssembly limits vary by device.
- This starter caps input at 450 MB, but that is not a promise that every iPhone can process a file that large. For best reliability, start with short 1080p MP4/MOV clips and close other Safari tabs.
- FFmpeg WebAssembly assets are downloaded from unpkg on first export. Media stays in browser memory and is not uploaded to the app or Vercel. Network access is needed to download the engine.
- Input videos need an audio track that FFmpeg can decode. This version exports MP4 with AAC audio and copies the first video stream. It does not preserve subtitles, extra audio tracks, chapters, or every possible metadata field.
- Video stream copy preserves the encoded video stream without quality loss, but the audio is newly encoded. The exported file may not keep the source container's exact metadata or rotation behavior for every phone/camera format.
- The included reverb is a generated synthetic stereo impulse response. It is an adjustable prototype, not a studio convolution reverb with a recorded concert-hall impulse response.

## Technical choices

- Next.js App Router and React.
- Web Audio API `OfflineAudioContext` for offline effect rendering.
- FFmpeg WebAssembly for audio extraction and remuxing.
- `-c:v copy` to avoid video re-encoding, and AAC 192 kbps for processed audio.

## If export fails on iOS

Try a shorter/smaller MP4 or MOV file, close background Safari tabs, and reload the page. iOS can terminate a tab when memory is exhausted. A more robust production version could use a native iOS app or a server-side job system, but those choices no longer guarantee free processing.
