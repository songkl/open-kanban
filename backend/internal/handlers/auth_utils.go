package handlers

import (
	"crypto/rand"
	"encoding/hex"
	"os"
	"reflect"
	"strconv"
	"strings"
	"unicode/utf8"
)

func generateID() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		panic("crypto/rand unavailable")
	}
	return hex.EncodeToString(b)
}

func generateTokenKey() string {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		panic("crypto/rand unavailable")
	}
	return hex.EncodeToString(b)
}

func getEnvInt(key string, defaultVal int) int {
	if val := os.Getenv(key); val != "" {
		if intVal, err := strconv.Atoi(val); err == nil && intVal > 0 {
			return intVal
		}
	}
	return defaultVal
}

func validateInputLength(value string, maxLength int) bool {
	return len(value) <= maxLength
}

func sanitizeString(s string) string {
	if !utf8.ValidString(s) {
		return strings.ToValidUTF8(s, "")
	}
	return s
}

func sanitizeValue(v any) any {
	if v == nil {
		return nil
	}
	rv := reflect.ValueOf(v)
	switch rv.Kind() {
	case reflect.Ptr:
		if rv.IsNil() {
			return nil
		}
		elem := rv.Elem().Interface()
		sanitized := sanitizeValue(elem)
		if sanitized == nil {
			return nil
		}
		ptr := reflect.New(reflect.TypeOf(sanitized))
		ptr.Elem().Set(reflect.ValueOf(sanitized))
		return ptr.Interface()
	case reflect.Struct:
		sanitized := reflect.New(rv.Type()).Elem()
		for i := 0; i < rv.NumField(); i++ {
			field := rv.Field(i)
			fieldType := rv.Type().Field(i)
			if fieldType.Type.Kind() == reflect.String {
				if field.CanInterface() {
					sanitized.Field(i).SetString(sanitizeString(field.Interface().(string)))
				}
			} else {
				if field.CanInterface() {
					sanitized.Field(i).Set(reflect.ValueOf(sanitizeValue(field.Interface())))
				}
			}
		}
		return sanitized.Interface()
	case reflect.Map:
		sanitized := reflect.MakeMap(rv.Type())
		for _, key := range rv.MapKeys() {
			mapVal := rv.MapIndex(key)
			sanitized.SetMapIndex(key, reflect.ValueOf(sanitizeValue(mapVal.Interface())))
		}
		return sanitized.Interface()
	case reflect.Slice:
		sanitized := reflect.MakeSlice(rv.Type(), rv.Len(), rv.Cap())
		for i := 0; i < rv.Len(); i++ {
			sanitized.Index(i).Set(reflect.ValueOf(sanitizeValue(rv.Index(i).Interface())))
		}
		return sanitized.Interface()
	case reflect.String:
		return sanitizeString(v.(string))
	default:
		return v
	}
}

func sanitizeActivity(a any) any {
	return sanitizeValue(a)
}

func sanitizeActivityForBroadcast(a Activity) Activity {
	sanitized := sanitizeValue(a)
	if s, ok := sanitized.(Activity); ok {
		return s
	}
	return a
}
