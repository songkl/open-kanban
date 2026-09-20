package handlers

import (
	"database/sql"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
)

// CheckOriginAllowed answers GET /api/v1/origins/check with a
// payload the SPA can read before opening the WebSocket. It reports
// whether the request's `Origin` header (or `Referer` fallback) is on
// the server's allow-list and, when it isn't, returns the
// human-readable hint the toast surfaces — "确认 ALLOWED_ORIGINS
// 包含当前访问地址" / "Confirm ALLOWED_ORIGINS contains ...".
//
// The endpoint is intentionally unauthenticated: the SPA calls it
// before opening the WebSocket so the toast can show a useful hint on
// the first failed handshake, not after several reconnect attempts
// have already filled the console with 403s (s-1260 / PM review
// s-1258 P2-11).
//
// The *sql.DB argument mirrors the handler factory shape used by
// the rest of the package so future expansions (rate-limiting, audit
// logging) can hook in without changing the call site.
func CheckOriginAllowed(_ *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		origin := strings.TrimSpace(c.GetHeader("Origin"))
		if origin == "" {
			origin = strings.TrimSpace(c.GetHeader("Referer"))
		}
		allowed := false
		if origin != "" {
			for _, candidate := range GetAllowedOrigins() {
				if strings.EqualFold(candidate, origin) {
					allowed = true
					break
				}
			}
		}
		c.JSON(http.StatusOK, gin.H{
			"origin":    origin,
			"allowed":   allowed,
			"allowList": GetAllowedOrigins(),
			"hint":      hintForOrigin(allowed, origin),
		})
	}
}

// hintForOrigin returns the message the WsWarning toast renders when
// the SPA can't connect. English + Chinese are hard-coded so the
// toast stays useful even before i18next hydrates on the public
// /status page.
func hintForOrigin(allowed bool, origin string) string {
	if allowed {
		return ""
	}
	en := "WebSocket connection was refused (403). Confirm ALLOWED_ORIGINS contains the address you are loading the app from (e.g. `" + origin + "`), then restart the server."
	zh := "WebSocket 连接被服务器拒绝 (403)。请确认 ALLOWED_ORIGINS 包含当前访问地址 `" + origin + "`，然后重启服务。"
	return en + "\n\n" + zh
}