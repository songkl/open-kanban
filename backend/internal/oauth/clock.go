package oauth

import "time"

// timeNow is an indirection over time.Now so tests can pin the clock.
var timeNow = func() time.Time {
	return time.Now()
}