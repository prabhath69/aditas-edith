import { useState, useRef, useCallback, useEffect } from 'react';

// ─── Types ───────────────────────────────────────────────────────────────────

interface SpeechToTextOptions {
    /** Called with the final transcribed text when speech recognition completes */
    onResult: (transcript: string) => void;
    /** Language for recognition (BCP-47). Default: 'en-US' */
    lang?: string;
    /** Whether to allow continuous listening. Default: true */
    continuous?: boolean;
}

interface SpeechToTextReturn {
    /** Whether the mic is currently listening */
    isListening: boolean;
    /** Interim (in-progress) transcript while speaking */
    interimTranscript: string;
    /** Start listening for speech */
    startListening: () => void;
    /** Stop listening (does NOT trigger onResult) */
    stopListening: () => void;
    /** Last error message, if any */
    error: string | null;
}

// ─── Hook ────────────────────────────────────────────────────────────────────

export function useSpeechToText({
    onResult,
    lang = 'en-US',
    continuous = true,
}: SpeechToTextOptions): SpeechToTextReturn {
    const [isListening, setIsListening] = useState(false);
    const [interimTranscript, setInterimTranscript] = useState('');
    const [error, setError] = useState<string | null>(null);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const recognitionRef = useRef<any>(null);
    const onResultRef = useRef(onResult);
    const finalTranscriptRef = useRef('');

    // Keep the callback ref up-to-date without re-creating the recognition instance
    useEffect(() => {
        onResultRef.current = onResult;
    }, [onResult]);

    const startListening = useCallback(() => {
        setError(null);

        // Access webkitSpeechRecognition (Chrome) or SpeechRecognition (standard)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const win = window as any;
        const SpeechRecognitionCtor = win.webkitSpeechRecognition || win.SpeechRecognition;

        if (!SpeechRecognitionCtor) {
            setError('Speech recognition is not supported in this browser.');
            return;
        }

        // Stop any existing session
        if (recognitionRef.current) {
            try { recognitionRef.current.abort(); } catch { /* ignore */ }
        }

        const recognition = new SpeechRecognitionCtor();
        recognition.lang = lang;
        recognition.continuous = continuous;
        recognition.interimResults = true;
        recognition.maxAlternatives = 1;

        finalTranscriptRef.current = '';

        recognition.onstart = () => {
            setIsListening(true);
            setInterimTranscript('');
        };

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        recognition.onresult = (event: any) => {
            let interim = '';
            let final = '';

            for (let i = 0; i < event.results.length; i++) {
                const result = event.results[i];
                if (result.isFinal) {
                    final += result[0].transcript;
                } else {
                    interim += result[0].transcript;
                }
            }

            if (final) {
                finalTranscriptRef.current += (finalTranscriptRef.current ? ' ' : '') + final.trim();
            }

            setInterimTranscript(interim);
        };

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        recognition.onerror = (event: any) => {
            // 'no-speech' and 'aborted' are not real errors
            if (event.error === 'no-speech' || event.error === 'aborted') return;

            if (event.error === 'not-allowed') {
                setError('Microphone access denied. Please allow microphone permission.');
            } else {
                setError(`Speech recognition error: ${event.error}`);
            }
            setIsListening(false);
        };

        recognition.onend = () => {
            setIsListening(false);
            setInterimTranscript('');

            // Deliver the accumulated final transcript
            const text = finalTranscriptRef.current.trim();
            if (text) {
                onResultRef.current(text);
                finalTranscriptRef.current = '';
            }
        };

        recognitionRef.current = recognition;

        try {
            recognition.start();
        } catch (err) {
            setError(`Failed to start speech recognition: ${String(err)}`);
        }
    }, [lang, continuous]);

    const stopListening = useCallback(() => {
        if (recognitionRef.current) {
            try {
                // .stop() triggers onend which will deliver the final transcript
                recognitionRef.current.stop();
            } catch { /* ignore */ }
        }
    }, []);

    // Cleanup on unmount
    useEffect(() => {
        return () => {
            if (recognitionRef.current) {
                try { recognitionRef.current.abort(); } catch { /* ignore */ }
            }
        };
    }, []);

    return { isListening, interimTranscript, startListening, stopListening, error };
}

