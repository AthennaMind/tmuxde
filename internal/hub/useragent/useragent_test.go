package useragent

import "testing"

const (
	iosSafari     = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1"
	androidChrome = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36"
	macChrome     = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
	edge          = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0"
	firefox       = "Mozilla/5.0 (X11; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0"
	iosFirefox    = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/127.0 Mobile/15E148 Safari/605.1.15"
	curl          = "curl/8.5.0"
	// Playwright's Chromium. HeadlessChrome/ is one word, so \bChrome/ never
	// matched and the trailing Safari/ won.
	headless = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/154.0.0.0 Safari/537.36"
)

type uaCase struct {
	ua   string
	want string
}

func TestDescribe(t *testing.T) {
	tests := []struct {
		name  string
		cases []uaCase
	}{
		{
			name: "names the browser and the platform",
			cases: []uaCase{
				{iosSafari, "Safari on iPhone"},
				{androidChrome, "Chrome on Android"},
				{macChrome, "Chrome on Mac"},
				{firefox, "Firefox on Linux"},
			},
		},
		{
			// Every browser impersonates the ones below it. Edge says Chrome
			// and Safari. Chrome says Safari. Firefox on iOS says Safari.
			// Test the impersonations. The happy path cannot fail.
			name: "is not fooled by a browser claiming to be another",
			cases: []uaCase{
				{edge, "Edge on Windows"},
				{androidChrome, "Chrome on Android"},
				{iosFirefox, "Firefox on iPhone"},
				{headless, "Chrome on Linux"},
			},
		},
		{
			name: "says whichever half it is sure of",
			cases: []uaCase{
				{"curl/8.5.0 (Linux)", "Linux"},
				{"Chrome/1.0", "Chrome"},
			},
		},
		{
			// Empty rather than a guess. The caller falls back to a neutral
			// label. A confident wrong answer is worse than a vague one.
			name: "admits when it does not know",
			cases: []uaCase{
				{curl, ""},
				{"", ""},
			},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			for _, c := range tt.cases {
				if got := Describe(c.ua); got != c.want {
					t.Errorf("Describe(%q) = %q, want %q", c.ua, got, c.want)
				}
			}
		})
	}
}
