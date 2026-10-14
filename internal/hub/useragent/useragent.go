// Package useragent names a browser user agent the way a person would say
// it, such as "Safari on iPhone". Port of apps/relay/src/user-agent.ts.
//
// A short table, not a UA database. It covers the browsers and platforms a
// terminal client turns up in. An agent it does not recognise gives an empty
// result, and the caller falls back to a neutral label. A confident wrong
// answer is worse than a vague one.
//
// The order of each table is the whole implementation. Browsers impersonate
// each other in one direction. Chrome says Safari. Edge says Chrome and
// Safari. Opera says all three. So the most specific claim is tested first,
// and the order must stay as it is.
package useragent

import "regexp"

type rule struct {
	name string
	re   *regexp.Regexp
}

// browsers is ordered. First match wins.
var browsers = []rule{
	// Before Chrome: these all carry "Chrome" in their own UA.
	{"Edge", regexp.MustCompile(`\bEdg[A-Z]?/`)},
	{"Opera", regexp.MustCompile(`\bOPR/`)},
	{"Samsung Internet", regexp.MustCompile(`\bSamsungBrowser/`)},
	{"Vivaldi", regexp.MustCompile(`\bVivaldi/`)},
	{"Brave", regexp.MustCompile(`\bBrave/`)},
	// Before Safari: Chrome carries "Safari", and so does every engine above.
	// Headless Chrome says HeadlessChrome/, where \bChrome/ cannot match.
	{"Chrome", regexp.MustCompile(`\b(?:CriOS|Chrome|Chromium|HeadlessChrome)/`)},
	// Firefox on iOS carries "Safari" too, because iOS makes it use WebKit.
	{"Firefox", regexp.MustCompile(`\b(?:FxiOS|Firefox)/`)},
	{"Safari", regexp.MustCompile(`\bSafari/`)},
}

// platforms is ordered. First match wins.
var platforms = []rule{
	// iPhone and iPad before Mac: both say "like Mac OS X".
	{"iPhone", regexp.MustCompile(`\biPhone\b`)},
	{"iPad", regexp.MustCompile(`\biPad\b`)},
	// Android before Linux: Android says "Linux".
	{"Android", regexp.MustCompile(`\bAndroid\b`)},
	{"Windows", regexp.MustCompile(`\bWindows NT\b`)},
	{"Linux", regexp.MustCompile(`\b(?:Linux|X11)\b`)},
	{"Mac", regexp.MustCompile(`\b(?:Macintosh|Mac OS X)\b`)},
}

// Describe returns "Browser on Platform", or only the half it recognises,
// or "" when it recognises neither. A browser without a known platform is
// still worth naming, and so is a platform without a known browser.
func Describe(ua string) string {
	if ua == "" {
		return ""
	}
	browser := match(browsers, ua)
	platform := match(platforms, ua)
	switch {
	case browser != "" && platform != "":
		return browser + " on " + platform
	case browser != "":
		return browser
	default:
		return platform
	}
}

func match(rules []rule, ua string) string {
	for _, r := range rules {
		if r.re.MatchString(ua) {
			return r.name
		}
	}
	return ""
}
