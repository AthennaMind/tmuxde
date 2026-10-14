package sherpa

// RecognizerConfig names the files of a Parakeet TDT transducer and the
// decode settings that vary.
type RecognizerConfig struct {
	Encoder    string
	Decoder    string
	Joiner     string
	Tokens     string
	Threads    int
	SampleRate int
}

// VADConfig names the Silero model.
type VADConfig struct {
	Model      string
	SampleRate int
}

// Fixed settings. They match what the former Node service used.
const (
	featureDim     = 80
	provider       = "cpu"
	decodingMethod = "greedy_search"

	vadThreshold = 0.5
	// Shorter pauses happen inside sentences. Longer ones end a thought.
	vadMinSilence = 0.6
	vadMinSpeech  = 0.25
	// Silero runs on 32 ms windows at 16 kHz.
	vadWindow        = 512
	vadMaxSpeech     = 25
	vadBufferSeconds = 60
)
