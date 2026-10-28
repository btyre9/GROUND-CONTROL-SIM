"""Makes a recording loop without a click or a jump: trims the ends, then blends the last few seconds into
the first so the loop's end flows into its start. Works on 16-bit PCM WAV (convert with afconvert first).

    python3 make_loop.py IN.wav OUT.wav [--trim-start 3] [--trim-end 3] [--fade 4]
"""
import argparse
import array
import wave


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('source'); parser.add_argument('out')
    parser.add_argument('--trim-start', type=float, default=0, help='Seconds to drop from the start')
    parser.add_argument('--trim-end', type=float, default=0, help='Seconds to drop from the end')
    parser.add_argument('--fade', type=float, default=4, help='Seconds of overlap blended at the loop point')
    args = parser.parse_args()

    with wave.open(args.source) as w:
        channels, rate, width = w.getnchannels(), w.getframerate(), w.getsampwidth()
        if width != 2:
            raise SystemExit('Needs 16-bit PCM.')
        samples = array.array('h', w.readframes(w.getnframes()))
    frames = len(samples) // channels
    start, end = int(args.trim_start * rate), frames - int(args.trim_end * rate)
    fade = int(args.fade * rate)
    body = samples[start * channels:end * channels]
    n = len(body) // channels
    # The loop is the body minus its last `fade` seconds, which are blended into its first `fade` seconds.
    out = body[:(n - fade) * channels]
    for i in range(fade):
        t = i / fade
        for c in range(channels):
            tail = body[(n - fade + i) * channels + c]
            head = body[i * channels + c]
            out[i * channels + c] = max(-32768, min(32767, int(head * t + tail * (1 - t))))
    with wave.open(args.out, 'wb') as w:
        w.setnchannels(channels); w.setsampwidth(2); w.setframerate(rate)
        w.writeframes(out.tobytes())
    print(f'{args.out}: {(n - fade) / rate:.1f} s loop')


if __name__ == '__main__':
    main()
