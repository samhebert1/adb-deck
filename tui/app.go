package tui

import (
	"context"
	"fmt"
	"strings"
	"time"

	"adb-deck/core"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
)

type tabIndex int

const (
	tabDevices tabIndex = iota
	tabPairing
	tabAPKs
	tabScrcpy
)

var (
	accentColor = lipgloss.Color("#7C3AED")
	cyanColor   = lipgloss.Color("#06B6D4")
	greenColor  = lipgloss.Color("#10B981")
	mutedColor  = lipgloss.Color("#94A3B8")

	titleStyle = lipgloss.NewStyle().
			Bold(true).
			Foreground(lipgloss.Color("#FFFFFF")).
			Background(accentColor).
			Padding(0, 2)

	activeTabStyle = lipgloss.NewStyle().
			Bold(true).
			Foreground(lipgloss.Color("#FFFFFF")).
			Background(cyanColor).
			Padding(0, 2)

	inactiveTabStyle = lipgloss.NewStyle().
				Foreground(mutedColor).
				Padding(0, 2)

	panelStyle = lipgloss.NewStyle().
			Border(lipgloss.RoundedBorder()).
			BorderForeground(accentColor).
			Padding(1, 2)

	selectedRowStyle = lipgloss.NewStyle().
				Bold(true).
				Foreground(cyanColor)

	statusStyle = lipgloss.NewStyle().
			Foreground(greenColor)

	helpStyle = lipgloss.NewStyle().
			Foreground(mutedColor)
)

type devicesMsg struct {
	devices []core.Device
	err     error
}

type packagesMsg struct {
	packages []core.PackageInfo
	err      error
}

type qrMsg struct {
	session *core.PairingSession
	err     error
}

type actionResultMsg struct {
	message string
	err     error
}

type tickMsg time.Time

// Model is the Bubble Tea TUI state backed by the shared ADB Engine.
type Model struct {
	engine      *core.Engine
	tab         tabIndex
	devices     []core.Device
	deviceIdx   int
	packages    []core.PackageInfo
	pkgIdx      int
	pairing     *core.PairingSession
	statusLine  string
	width       int
	height      int
}

// Run launches the interactive Bubble Tea TUI.
func Run(engine *core.Engine) error {
	m := Model{
		engine:     engine,
		tab:        tabDevices,
		statusLine: "Ready — press r to refresh devices, 1-4 to switch tabs",
	}
	p := tea.NewProgram(m, tea.WithAltScreen())
	_, err := p.Run()
	return err
}

// Init schedules the initial device fetch and periodic 3-second polling ticker.
func (m Model) Init() tea.Cmd {
	return tea.Batch(m.fetchDevicesCmd(), tickEvery())
}

func tickEvery() tea.Cmd {
	return tea.Tick(3*time.Second, func(t time.Time) tea.Msg { return tickMsg(t) })
}

func (m Model) fetchDevicesCmd() tea.Cmd {
	return func() tea.Msg {
		devs, err := m.engine.ListDevices(context.Background())
		return devicesMsg{devices: devs, err: err}
	}
}

func (m Model) fetchPackagesCmd(serial string) tea.Cmd {
	return func() tea.Msg {
		pkgs, err := m.engine.ListPackages(context.Background(), serial, false)
		return packagesMsg{packages: pkgs, err: err}
	}
}

func (m Model) startQRCmd() tea.Cmd {
	return func() tea.Msg {
		sess, err := m.engine.StartQRPairing(context.Background())
		return qrMsg{session: sess, err: err}
	}
}

func (m Model) selectedDevice() *core.Device {
	if len(m.devices) == 0 || m.deviceIdx >= len(m.devices) {
		return nil
	}
	return &m.devices[m.deviceIdx]
}

// Update processes Bubble Tea window, polling, async ADB result, and keyboard messages.
func (m Model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		m.width = msg.Width
		m.height = msg.Height
	case tickMsg:
		m.pairing = m.engine.GetPairingSession()
		return m, tea.Batch(m.fetchDevicesCmd(), tickEvery())
	case devicesMsg:
		if msg.err != nil {
			m.statusLine = "ADB error: " + msg.err.Error()
		} else {
			m.devices = msg.devices
			if m.deviceIdx >= len(m.devices) && len(m.devices) > 0 {
				m.deviceIdx = len(m.devices) - 1
			}
		}
	case packagesMsg:
		if msg.err != nil {
			m.statusLine = "APK list error: " + msg.err.Error()
		} else {
			m.packages = msg.packages
			m.pkgIdx = 0
			m.statusLine = fmt.Sprintf("Loaded %d third-party packages", len(msg.packages))
		}
	case qrMsg:
		if msg.err != nil {
			m.statusLine = "QR error: " + msg.err.Error()
		} else {
			m.pairing = msg.session
			m.statusLine = "QR Pairing active — scan with Android Wireless Debugging"
		}
	case actionResultMsg:
		if msg.err != nil {
			m.statusLine = "Error: " + msg.err.Error()
		} else {
			m.statusLine = msg.message
		}
		return m, m.fetchDevicesCmd()
	case tea.KeyMsg:
		switch msg.String() {
		case "ctrl+c", "q":
			return m, tea.Quit
		case "1":
			m.tab = tabDevices
		case "2":
			m.tab = tabPairing
		case "3":
			m.tab = tabAPKs
			if d := m.selectedDevice(); d != nil && len(m.packages) == 0 {
				m.statusLine = "Loading packages for " + d.Model + "..."
				return m, m.fetchPackagesCmd(d.Serial)
			}
		case "4":
			m.tab = tabScrcpy
		case "tab":
			m.tab = (m.tab + 1) % 4
		case "up", "k":
			if m.tab == tabDevices && m.deviceIdx > 0 {
				m.deviceIdx--
			} else if m.tab == tabAPKs && m.pkgIdx > 0 {
				m.pkgIdx--
			}
		case "down", "j":
			if m.tab == tabDevices && m.deviceIdx < len(m.devices)-1 {
				m.deviceIdx++
			} else if m.tab == tabAPKs && m.pkgIdx < len(m.packages)-1 {
				m.pkgIdx++
			}
		case "r":
			m.statusLine = "Refreshing..."
			if m.tab == tabAPKs {
				if d := m.selectedDevice(); d != nil {
					return m, m.fetchPackagesCmd(d.Serial)
				}
			}
			return m, m.fetchDevicesCmd()
		case "p":
			if m.tab == tabPairing {
				return m, m.startQRCmd()
			}
		case "m":
			if d := m.selectedDevice(); d != nil {
				serial := d.Serial
				return m, func() tea.Msg {
					if _, err := m.engine.StartScrcpy(core.ScrcpyOptions{
						Serial:    serial,
						MaxSize:   1440,
						StayAwake: true,
					}); err != nil {
						return actionResultMsg{err: err}
					}
					return actionResultMsg{message: "Launched scrcpy for " + serial}
				}
			}
		case "s":
			if d := m.selectedDevice(); d != nil {
				serial := d.Serial
				return m, func() tea.Msg {
					if err := m.engine.StopScrcpy(serial); err != nil {
						return actionResultMsg{err: err}
					}
					return actionResultMsg{message: "Stopped scrcpy for " + serial}
				}
			}
		case "c":
			if m.tab == tabAPKs && len(m.packages) > 0 {
				if d := m.selectedDevice(); d != nil {
					pkg := m.packages[m.pkgIdx].Package
					serial := d.Serial
					return m, func() tea.Msg {
						out, err := m.engine.ClearPackageData(context.Background(), serial, pkg)
						return actionResultMsg{message: "Cleared " + pkg + ": " + out, err: err}
					}
				}
			}
		}
	}
	return m, nil
}

// View renders the header tabs, active tab panel, status bar, and key hints.
func (m Model) View() string {
	var b strings.Builder

	header := titleStyle.Render("ADB DECK :: TUI")
	tabs := []string{"1 Devices", "2 QR Pairing", "3 APK Manager", "4 scrcpy"}
	var renderedTabs []string
	for i, t := range tabs {
		if tabIndex(i) == m.tab {
			renderedTabs = append(renderedTabs, activeTabStyle.Render(t))
		} else {
			renderedTabs = append(renderedTabs, inactiveTabStyle.Render(t))
		}
	}

	b.WriteString(header + "  " + strings.Join(renderedTabs, " ") + "\n\n")

	var body string
	switch m.tab {
	case tabDevices:
		body = m.viewDevices()
	case tabPairing:
		body = m.viewPairing()
	case tabAPKs:
		body = m.viewAPKs()
	case tabScrcpy:
		body = m.viewScrcpy()
	}

	b.WriteString(panelStyle.Render(body) + "\n\n")
	b.WriteString(statusStyle.Render("Status: "+m.statusLine) + "\n")
	b.WriteString(helpStyle.Render("Keys: [1-4/Tab] Switch tab • [↑/↓] Select • [r] Refresh • [m/s] Start/Stop scrcpy • [p] New QR • [q] Quit"))
	return b.String()
}

func (m Model) viewDevices() string {
	if len(m.devices) == 0 {
		return "No ADB devices detected.\nPlug in a phone via USB or press [2] for Wireless QR Pairing."
	}
	var lines []string
	lines = append(lines, "Connected Android Devices:\n")
	for i, d := range m.devices {
		cursor := "  "
		if i == m.deviceIdx {
			cursor = "▶ "
		}
		mirrorTag := ""
		if d.Mirroring {
			mirrorTag = " [MIRRORING]"
		}
		row := fmt.Sprintf("%s%-22s  %-8s  Android %-4s  Bat %-4s  (%s)%s",
			cursor, d.Model, d.Transport, d.AndroidVersion, d.Battery, d.State, mirrorTag)
		if i == m.deviceIdx {
			row = selectedRowStyle.Render(row)
		}
		lines = append(lines, row)
	}
	return strings.Join(lines, "\n")
}

func (m Model) viewPairing() string {
	if m.pairing == nil {
		return "Click-and-Go Wireless QR Pairing (Android 11+)\n\nPress [p] to generate a live scannable QR code.\nThen open Developer Options -> Wireless Debugging -> Pair device with QR code."
	}
	return fmt.Sprintf("Service: %s  |  Status: %s\n%s\n\n%s",
		m.pairing.ServiceName, strings.ToUpper(m.pairing.Status), m.pairing.Message, m.pairing.QRText)
}

func (m Model) viewAPKs() string {
	d := m.selectedDevice()
	if d == nil {
		return "Select a device on tab [1] first."
	}
	if len(m.packages) == 0 {
		return fmt.Sprintf("No packages loaded for %s yet. Press [r] to load.", d.Model)
	}
	start := m.pkgIdx - 6
	if start < 0 {
		start = 0
	}
	end := start + 14
	if end > len(m.packages) {
		end = len(m.packages)
	}
	var lines []string
	lines = append(lines, fmt.Sprintf("Third-Party Packages on %s (%d total) — [c] Clear Data:\n", d.Model, len(m.packages)))
	for i := start; i < end; i++ {
		cursor := "  "
		if i == m.pkgIdx {
			cursor = "▶ "
		}
		row := cursor + m.packages[i].Package
		if i == m.pkgIdx {
			row = selectedRowStyle.Render(row)
		}
		lines = append(lines, row)
	}
	return strings.Join(lines, "\n")
}

func (m Model) viewScrcpy() string {
	d := m.selectedDevice()
	if d == nil {
		return "No device selected. Switch to tab [1] to pick a device."
	}
	status := "Idle"
	if d.Mirroring {
		status = "Running"
	}
	return fmt.Sprintf("scrcpy Mirroring Controller\n\nTarget Device: %s (%s)\nSession State: %s\n\nPress [m] to start mirroring (1440p, stay-awake)\nPress [s] to stop mirroring",
		d.Model, d.Serial, status)
}
