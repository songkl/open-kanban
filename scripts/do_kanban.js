const fs = require('fs');
const path = require('path');

// Simple SQLite file reader - reads the raw database file
const dbPath = path.join(__dirname, '..', 'backend', 'kanban.db');

// Read the database file
const data = fs.readFileSync(dbPath, 'utf8');

// Extract task titles and IDs using string patterns
// Tasks in SQLite are stored with specific patterns
const taskPattern = /\|([^|]*)\|/g;

console.log('Reading kanban database...');
console.log('File size:', fs.statSync(dbPath).size, 'bytes');

// Look for known task-related strings
const lines = data.split('\n');
let inTasksTable = false;
let taskCount = 0;

for (let i = 0; i < Math.min(lines.length, 500); i++) {
    const line = lines[i];
    if (line.includes('tasks') && line.includes('CREATE')) {
        inTasksTable = true;
        console.log('\nFound tasks table at line', i);
    }
}

// Parse the database more carefully
// SQLite stores records in pages - let's look for text records
const textDecoder = new TextDecoder();
const buffer = fs.readFileSync(dbPath);

console.log('\n=== Searching for task records ===\n');

// Look for high priority markers and task titles
const str = buffer.toString('utf8', 0, Math.min(buffer.length, 100000));
const matches = str.match(/[\u4e00-\u9fa5_a-zA-Z0-9\s]{10,100}/g) || [];

const uniqueMatches = [...new Set(matches)].filter(m =>
    m.includes('待办') ||
    m.includes('进行') ||
    m.includes('审核') ||
    m.includes('完成') ||
    m.includes('fix') ||
    m.includes('feat') ||
    m.includes('bug') ||
    m.includes('task') ||
    m.includes('Task')
);

console.log('Found relevant strings:');
uniqueMatches.slice(0, 20).forEach(m => console.log(' -', m.substring(0, 80)));
