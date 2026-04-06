package handlers

import (
	"compress/gzip"
	"io"
	"net/http"
	"strings"
	"sync"

	"github.com/gin-gonic/gin"
)

type gzipWriter struct {
	gin.ResponseWriter
	writer io.Writer
}

func (g *gzipWriter) Write(data []byte) (int, error) {
	return g.writer.Write(data)
}

var (
	gzipPool = sync.Pool{
		New: func() interface{} {
			w := gzip.NewWriter(io.Discard)
			return w
		},
	}
)

func getGzipWriter() *gzip.Writer {
	w := gzipPool.Get().(*gzip.Writer)
	w.Reset(io.Discard)
	return w
}

func putGzipWriter(w *gzip.Writer) {
	gzipPool.Put(w)
}

func CompressionMiddleware() gin.HandlerFunc {
	return func(c *gin.Context) {
		if !shouldCompress(c) {
			c.Next()
			return
		}

		encoding := parseEncoding(c)
		if encoding == "" {
			c.Next()
			return
		}

		if encoding == "gzip" {
			handleGzip(c)
		} else {
			c.Next()
		}
	}
}

func shouldCompress(c *gin.Context) bool {
	if c.Request.Method == "OPTIONS" {
		return false
	}

	acceptEncoding := c.Request.Header.Get("Accept-Encoding")
	if acceptEncoding == "" {
		return false
	}

	return strings.Contains(acceptEncoding, "gzip") || strings.Contains(acceptEncoding, "br")
}

func parseEncoding(c *gin.Context) string {
	acceptEncoding := c.Request.Header.Get("Accept-Encoding")
	if acceptEncoding == "" {
		return ""
	}

	if strings.Contains(acceptEncoding, "br") {
		return "br"
	}
	if strings.Contains(acceptEncoding, "gzip") {
		return "gzip"
	}

	return ""
}

func handleGzip(c *gin.Context) {
	gz := getGzipWriter()
	c.Writer.Header().Set("Content-Encoding", "gzip")
	c.Writer.Header().Set("Vary", "Accept-Encoding")

	gzWriter := &gzipWriter{
		ResponseWriter: c.Writer,
		writer:         gz,
	}

	c.Writer = gzWriter

	c.Next()

	gz.Close()
	putGzipWriter(gz)
}

func ServeCompressed(filename string, contentType string, data []byte, c *gin.Context) {
	acceptEncoding := c.Request.Header.Get("Accept-Encoding")

	if acceptEncoding != "" && strings.Contains(acceptEncoding, "gzip") {
		c.Header("Content-Encoding", "gzip")
		c.Header("Vary", "Accept-Encoding")

		gz := getGzipWriter()
		defer putGzipWriter(gz)

		gz.Reset(io.Discard)
		if _, err := gz.Write(data); err != nil {
			c.Data(http.StatusInternalServerError, contentType, data)
			return
		}
		if err := gz.Close(); err != nil {
			c.Data(http.StatusInternalServerError, contentType, data)
			return
		}

		buf := new(strings.Builder)
		gz.Reset(buf)
		gz.Write(data)
		gz.Close()

		c.Data(http.StatusOK, contentType, []byte(buf.String()))
	} else {
		c.Data(http.StatusOK, contentType, data)
	}
}
