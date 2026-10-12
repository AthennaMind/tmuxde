package ws

import (
	"bytes"
	"os"
	"strconv"
)

// uptimeFile holds the system uptime in seconds as its first field.
const uptimeFile = "/proc/uptime"

// systemUptime is the system uptime in seconds, as os.uptime() in Node.
// It is 0 when the file cannot be read.
func systemUptime() float64 {
	data, err := os.ReadFile(uptimeFile)
	if err != nil {
		return 0
	}
	return parseUptime(data)
}

func parseUptime(data []byte) float64 {
	fields := bytes.Fields(data)
	if len(fields) == 0 {
		return 0
	}
	v, err := strconv.ParseFloat(string(fields[0]), 64)
	if err != nil || v < 0 {
		return 0
	}
	return v
}
