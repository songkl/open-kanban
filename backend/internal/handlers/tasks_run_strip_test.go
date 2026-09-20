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
