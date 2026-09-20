package handlers

import "testing"

func TestStripAnsi(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want string
	}{
		{
			name: "empty string is a no-op",
			in:   "",
			want: "",
		},
		{
			name: "removes the leading reset sequence",
			in:   "\x1b[0m\n> build · deepseek-v4-flash\n\x1b[0m$ date \"+%Y-%m-%d\"\n2026-09-20\n",
			want: "\n> build · deepseek-v4-flash\n$ date \"+%Y-%m-%d\"\n2026-09-20\n",
		},
		{
			name: "removes colourised mid-line sequences",
			in:   "device_code approved for client=\x1b[36mkanban-client\x1b[0m",
			want: "device_code approved for client=kanban-client",
		},
		{
			name: "leaves clean text untouched",
			in:   "everything already plain",
			want: "everything already plain",
		},
		{
			name: "removes compound parameter sequences (31;1)",
			in:   "\x1b[31;1mbold red\x1b[0m trailing",
			want: "bold red trailing",
		},
		{
			name: "removes cursor-control sequences (2J, H)",
			in:   "before\x1b[2Jafter\x1b[Hmove",
			want: "beforeaftermove",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := stripAnsi(tc.in); got != tc.want {
				t.Errorf("stripAnsi(%q) = %q, want %q", tc.in, got, tc.want)
			}
		})
	}
}

// TestRedactRunOutputHosts (s-1260 / PM review s-1258 P1-6) covers
// the read-side sanitiser that strips a developer's LAN host out of
// the persisted run output before it leaves the server. The pattern
// intentionally only matches IPv4 addresses — hostnames and IPv6
// stay readable.
func TestRedactRunOutputHosts(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want string
	}{
		{
			name: "empty string is a no-op",
			in:   "",
			want: "",
		},
		{
			name: "redacts the LAN host captured by the PM review",
			in:   "task and its board/column don't exist on the connected server (http://192.168.0.102:8080).",
			want: "task and its board/column don't exist on the connected server (<redacted-host>).",
		},
		{
			name: "redacts both http and https variants with a port",
			in:   "see https://10.0.0.7:9000/api or http://172.16.0.4:8080/health",
			want: "see <redacted-host>/api or <redacted-host>/health",
		},
		{
			name: "leaves hostnames alone (localhost, internal)",
			in:   "connect to http://localhost:8080 or https://kanban.internal/api",
			want: "connect to http://localhost:8080 or https://kanban.internal/api",
		},
		{
			name: "leaves clean text untouched",
			in:   "no URLs in this payload at all",
			want: "no URLs in this payload at all",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := redactRunOutputHosts(tc.in); got != tc.want {
				t.Errorf("redactRunOutputHosts(%q) = %q, want %q", tc.in, got, tc.want)
			}
		})
	}
}
