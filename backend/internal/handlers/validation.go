package handlers

import (
	"reflect"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/go-playground/validator/v10"
)

var validate *validator.Validate

func init() {
	validate = validator.New()
	validate.RegisterTagNameFunc(func(fld reflect.StructField) string {
		name := strings.SplitN(fld.Tag.Get("json"), ",", 2)[0]
		if name == "-" {
			return ""
		}
		return name
	})
}

func ValidateRequest(i interface{}) gin.HandlerFunc {
	return func(c *gin.Context) {
		if err := c.ShouldBindJSON(&i); err != nil {
			c.JSON(400, gin.H{"error": formatValidationError(err)})
			c.Abort()
			return
		}

		if err := validate.Struct(i); err != nil {
			c.JSON(400, gin.H{"error": formatValidationError(err)})
			c.Abort()
			return
		}

		c.Next()
	}
}

func ValidateRequestOnly(i interface{}) gin.HandlerFunc {
	return func(c *gin.Context) {
		if err := validate.Struct(i); err != nil {
			c.JSON(400, gin.H{"error": formatValidationError(err)})
			c.Abort()
			return
		}

		c.Next()
	}
}

func BindAndValidate(c *gin.Context, i interface{}) error {
	if err := c.ShouldBindJSON(i); err != nil {
		return err
	}
	if err := validate.Struct(i); err != nil {
		return err
	}
	return nil
}

func formatValidationError(err error) string {
	if validationErrors, ok := err.(validator.ValidationErrors); ok {
		for _, e := range validationErrors {
			field := e.Field()
			tag := e.Tag()

			switch tag {
			case "required":
				return field + " is required"
			case "min":
				return field + " must be at least " + e.Param()
			case "max":
				return field + " must be at most " + e.Param()
			case "len":
				return field + " must be exactly " + e.Param() + " characters"
			case "email":
				return field + " must be a valid email address"
			case "uuid":
				return field + " must be a valid UUID"
			case "oneof":
				return field + " must be one of: " + e.Param()
			default:
				return field + " is invalid"
			}
		}
	}
	return "Invalid request"
}
