// Builds an iCalendar (.ics) feed from task records. Times are "floating"
// (no time zone), so they show at the same clock time on every device.

const TIMED_ALERT = "-PT15M";   // 15 minutes before a timed task
const ALLDAY_ALERT = "PT9H";    // 9:00 on the day of an all-day task
const EVENT_MINUTES = 30;

function esc(s) {
  return String(s).replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
}

// Lines longer than 75 characters continue on the next line after a space (RFC 5545).
function fold(line) {
  const out = [];
  let rest = line;
  while (rest.length > 74) {
    out.push(rest.slice(0, 74));
    rest = " " + rest.slice(74);
  }
  out.push(rest);
  return out.join("\r\n");
}

const pad = (n) => String(n).padStart(2, "0");
const ymd = (d) => d.getUTCFullYear() + pad(d.getUTCMonth() + 1) + pad(d.getUTCDate());
const hms = (d) => pad(d.getUTCHours()) + pad(d.getUTCMinutes()) + "00";

function stamp(updated) {
  const digits = String(updated || "").replace(/[^0-9]/g, "");
  return digits.length >= 14 ? digits.slice(0, 8) + "T" + digits.slice(8, 14) + "Z" : "19700101T000000Z";
}

function build(tasks) {
  const lines = [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Task Manager//Home//EN", "CALSCALE:GREGORIAN",
    "X-WR-CALNAME:Tasks", "REFRESH-INTERVAL;VALUE=DURATION:PT15M", "X-PUBLISHED-TTL:PT15M",
  ];
  tasks.forEach((t) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t.due);
    if (!m) return;
    const day = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    const ev = ["BEGIN:VEVENT", "UID:" + t.id + "@task-manager", "DTSTAMP:" + stamp(t.updated),
      "SUMMARY:" + esc((t.starred ? "★ " : "") + t.title)];
    const tm = /^(\d{2}):(\d{2})$/.exec(t.time || "");
    if (tm) {
      const start = new Date(day.getTime() + (+tm[1] * 60 + +tm[2]) * 60000);
      const end = new Date(start.getTime() + EVENT_MINUTES * 60000);
      ev.push("DTSTART:" + ymd(start) + "T" + hms(start), "DTEND:" + ymd(end) + "T" + hms(end));
    } else {
      ev.push("DTSTART;VALUE=DATE:" + ymd(day), "DTEND;VALUE=DATE:" + ymd(new Date(day.getTime() + 864e5)));
    }
    const details = [t.desc, "List: " + t.list + (t.priority === "High" ? " · High priority" : "")].filter(Boolean).join("\n\n");
    ev.push("DESCRIPTION:" + esc(details), "CATEGORIES:" + esc(t.list));
    if (t.priority === "High") ev.push("PRIORITY:1");
    ev.push("BEGIN:VALARM", "ACTION:DISPLAY", "DESCRIPTION:" + esc(t.title),
      "TRIGGER" + (tm ? ":" + TIMED_ALERT : ";RELATED=START:" + ALLDAY_ALERT), "END:VALARM", "END:VEVENT");
    ev.forEach((l) => lines.push(fold(l)));
  });
  lines.push("END:VCALENDAR");
  return lines.join("\r\n") + "\r\n";
}

module.exports = { build };
