package version

import (
	"os/exec"
	"strings"
)

func GetGitVersion() string {
	cmd := exec.Command("git", "describe", "--tags", "--abbrev=0")
	output, err := cmd.Output()
	if err != nil {
		return ""
	}
	version := strings.TrimSpace(string(output))
	version = strings.TrimPrefix(version, "v")
	return version
}

func GetFullGitVersion() string {
	cmd := exec.Command("git", "describe", "--tags")
	output, err := cmd.Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(output))
}

func GetPreviousGitVersion() string {
	cmd := exec.Command("git", "describe", "--tags", "--abbrev=0", "HEAD^")
	output, err := cmd.Output()
	if err != nil {
		return ""
	}
	version := strings.TrimSpace(string(output))
	version = strings.TrimPrefix(version, "v")
	return version
}

func IsVersionAtLeast(target string) bool {
	current := GetGitVersion()
	if current == "" {
		return false
	}
	return compareVersions(current, target) >= 0
}

func compareVersions(a, b string) int {
	partsA := strings.Split(a, ".")
	partsB := strings.Split(b, ".")

	maxLen := len(partsA)
	if len(partsB) > maxLen {
		maxLen = len(partsB)
	}

	for i := 0; i < maxLen; i++ {
		partA := 0
		partB := 0

		if i < len(partsA) {
			partA = parseVersionPart(partsA[i])
		}
		if i < len(partsB) {
			partB = parseVersionPart(partsB[i])
		}

		if partA > partB {
			return 1
		}
		if partA < partB {
			return -1
		}
	}
	return 0
}

func parseVersionPart(s string) int {
	num := 0
	for _, c := range s {
		if c >= '0' && c <= '9' {
			num = num*10 + int(c-'0')
		} else {
			break
		}
	}
	return num
}
