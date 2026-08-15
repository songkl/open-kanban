package oauth

import "testing"

func TestExternalProviderConfigGuards(t *testing.T) {
	cases := []struct {
		name string
		c    ExternalProviderConfig
		want bool
	}{
		{
			name: "disabled when Enabled=false",
			c:    ExternalProviderConfig{Provider: "google", ClientID: "x", Enabled: false},
			want: false,
		},
		{
			name: "disabled when provider empty",
			c:    ExternalProviderConfig{Provider: "", ClientID: "x", Enabled: true},
			want: false,
		},
		{
			name: "disabled when client_id empty",
			c:    ExternalProviderConfig{Provider: "google", ClientID: "", Enabled: true},
			want: false,
		},
		{
			name: "oidc requires issuer",
			c:    ExternalProviderConfig{Provider: "oidc", ClientID: "x", Enabled: true},
			want: false,
		},
		{
			name: "google with everything enabled",
			c:    ExternalProviderConfig{Provider: "google", ClientID: "x", ClientSecret: "s", Enabled: true},
			want: true,
		},
		{
			name: "oidc with issuer",
			c: ExternalProviderConfig{
				Provider: "oidc", ClientID: "x", ClientSecret: "s",
				Issuer: "https://example.com", Enabled: true,
			},
			want: true,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := tc.c.IsExternalEnabled(); got != tc.want {
				t.Errorf("IsExternalEnabled=%v, want %v", got, tc.want)
			}
		})
	}
}