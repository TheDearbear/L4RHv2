// Usage: node raw_printer sos.bun -LH -S -F0x80134101 -D
//                         /       /
//                  Chunks File   Additional arguments
// =========== Additional Arguments ============
// -S          | Use strings instead of bytes when printing buffer
// -H          | Hide long string by cutting middle part (only first and last 30(or 10 for bytes) chars of string)
// -LH         | Hide long string by cutting middle part (only first and last 90(or 30 for bytes) chars of string)
// -I0x*hexId* | Filter unnecessary chunks by id (works as include not exclude)
// -d          | Display docs for top-level chunks
// -D          | Display docs for every chunk (even for subchunk)
// -U          | Hide unknown fields in structs
// -E0x*hexId* | Filter unnecessary chunks by id (works as exclude not include)
// -i0x*hexId* | Filter unnecessary subchunks by id (works as include not exclude)
// -e0x*hexId* | Filter unnecessary subchunks by id (works as exclude not include)
// -l *number* | Maximum number of chunks to show
// --depth num | Maximum depth for chunk printing

if (process.argv.length < 3) {
	var lines = require("fs").readFileSync(__filename).toString().split(/\r?\n/);
	for (var i = 0, str = lines[i]; i < lines.length; i++, str = lines[i]) {
		if (!str.startsWith("// ")) break;
		console.log(str.slice(3));
	}
	process.exit(0);
}

const fs = require("fs");
var buffer = fs.readFileSync(process.argv[2]);

const idSize = 4;
const lengthSize = 4;
const headerSize = idSize + lengthSize;

const nest = JSON.parse(escapeHex(fs.readFileSync("subnests.json")));

var hideLong = process.argv.includes("-H") || process.argv.includes("-LH");
var useStr   = process.argv.includes("-S");
var hideMultiplier = process.argv.includes("-LH") ? 3 : 1;
var filters = getFilters("-I");
var exclude = getFilters("-E");
var subFilters = getFilters("-i");
var subExclude = getFilters("-e");
var basicDocs      = process.argv.includes("-d");
var docsEverywhere = process.argv.includes("-D");
var hideUnknown = process.argv.includes("-U");
var chunksLimit = getArgDataInt("-l");
var maxDepth = getArgDataInt("--depth");

var docs = basicDocs || docsEverywhere ? {...JSON.parse(fs.readFileSync("subchunk_magic_2.json")), ...JSON.parse(fs.readFileSync("chunk_magic_2.json"))} : {};


/*
Alternative method: iterate over buffer until null byte, remember position and take everything between offset and found position. This method should be more optimized.
Buffer.prototype.readAscii2 = function(offset = 0) {
	var i = offset;
	for (; this[i] != 0 && i < this.length; i++);
	return this.slice(offset, i).toString();
};
 */
Buffer.prototype.readAscii = function(offset = 0) {
	var result = "";
	for (var buffer = this.slice(offset); buffer[0] != 0 && buffer.length > 0; buffer = buffer.slice(1))
		result += String.fromCharCode(buffer[0]);
	
	return result;
};

printChunks(buffer, nest, true, true);

function printChunk(chunk, nest, useDocs, isTop, tabsize = 0) {
	var tabs = "    ".repeat(tabsize);
	
	var id = chunk.readUInt32LE();
	if (id == 0) return false;
	if (isTop && filters.length > 0 && !filters.includes(id)) return false;
	if (isTop && exclude.length > 0 && exclude.includes(id)) return false;
	if (!isTop && subFilters.length > 0 && !subFilters.includes(id)) return false;
	if (!isTop && subExclude.length > 0 && subExclude.includes(id)) return false;
	
	nest = getRightNest(id, nest);
	
	var idstr = int2HexBeStr(id);
	
	var size = chunk.readUInt32LE(idSize);
	
	if (nest && nest.ignore)
		return false;
	
	var postfix = size + 8 > chunk.length ? "| Remaining data size is smaller than chunk size! Potentially corrupted chunk" : "";
	
	chunk = chunk.slice(headerSize, size + headerSize);
	
	console.log(tabs + "Id: 0x" + idstr);
	if (nest && typeof nest.name === "string") {
		console.log(tabs + "Name: " + nest.name);
	}
	if (useDocs && (isTop ? basicDocs || docsEverywhere : docsEverywhere)) {
		console.log(tabs + "Description:", docs["0x" + idstr] || "Not found");
	}
	console.log(tabs + "Size:", size, postfix);
	if (size > 0) {
		var allowPrint = maxDepth == null || isNaN(maxDepth) || maxDepth > tabsize;
		
		if (!allowPrint) {
			console.log(tabs + "Payload: *Max Depth Reached*");
			return true;
		}
			
		var prefix = alignChunkData(chunk);
		if (prefix.length > 0)
			console.log(tabs + "Payload Align:", prefix.length, "bytes");
		
		chunk = prefix.chunk;
		
		console.log(tabs + "Payload: {");
		
		if (nest && nest.skip && allowPrint) {
			var skiped = chunk.slice(0, nest.skip);
			printBuffer(skiped, tabs + "    Skiped: ");
			chunk = chunk.slice(nest.skip);
		}

		if (nest && nest.subnests && !nest.raw) printChunks(chunk, nest.subnests, useDocs, false, tabsize + 1); // Subchunk
		else if (nest && nest.array && !nest.raw) printArrayedBuffer(chunk, nest, tabs + "    ");               // Array or Array<Struct>
		else if (nest && nest.struct && !nest.raw) printStruct(chunk, nest, tabs + "    ");                     // Struct
		else printBuffer(chunk, tabs + "    ");                                                                 // Raw data

		console.log(tabs + "}");
	}
	return true;
}

function printChunks(data, nest, useDocs, isTop, tabsize = 0) {
	var chunksI = 0;
	
	while (data.length >= headerSize) {
		var length = data.readUInt32LE(idSize);
		var payload = data.slice(0, headerSize + length);
		data = data.slice(headerSize + length);
		
		if (isTop && chunksI >= chunksLimit && !isNaN(chunksLimit))
			break;
		
		if (printChunk(payload, nest, useDocs, isTop, tabsize)) {
			console.log("");
			chunksI++;
		}
	}
	
	if (data.length > 0 && data.length < headerSize) {
		console.log("Unused data at end of chunks found:", buff2Str(data));
	}
}

function getRightNest(id, nests) {
	for (let i = 0; i < nests.length; i++)
		if (nests[i].id == id)
			return nests[i];
}

function int2HexBeStr(int) {
		let buffer = Buffer.alloc(4);
		buffer["write" + (int < 0 ? "" : "U") + "Int32BE"](int);
		return buffer.toString("hex");
}

function printBuffer(buffer, prefix, postfix) {
	var str = useStr ? normalizeStr(buffer.toString()) : buff2Str(buffer, true);
	
	console.log((prefix ? prefix : "") + str + (postfix ? postfix : ""));
}

function escapeHex(str) {
	str = str.toString();
	// Hax: using eval for fast convert from hex to dec
	while (exec = /0x([0-9A-F]){1,}/i.exec(str)) str = str.replace(exec[0], eval(exec[0]));
	return str;
}

function getFilters(arg) {
	var filters = [];
	process.argv.forEach(elem => {
		if (elem.startsWith(arg) && elem.length > 4) {
			var escaped = escapeHex(elem.slice(2));
			if (escaped == elem.slice(2)) return;
			filters.push(escaped - 0);
		}
	});
	return filters;
}

function printArrayedBuffer(chunk, nest, prefix) {
	var i = 0, postfix = chunk.length % nest.array > 0 ? `| Warning: Found data at end of array! (${chunk.length % nest.array})` : "";
	for (; chunk.length > 0; i++, chunk = chunk.slice(nest.array)) {
		if (nest.struct) {
			printStruct(chunk.slice(0, nest.array), nest, prefix);
			console.log();
		}
		else printBuffer(chunk.slice(0, nest.array), prefix);
	}
	
	console.log((prefix ? prefix : "") + "| Total Entries:", i, postfix);
}

function printStruct(chunk, nest, prefix, additional) {
	var struct = nest.struct, brk = false;
	
	// Select size specific structure.
	// hell nah man wtf, this is leftover from stone age.
	// this is not used in reality.
	// Anyway i'll keep this here.
	if (Array.isArray(nest.struct[0][0])) {
		for (var i = 0; i < nest.struct.length; i++) {
			for (var j = 0; j < nest.struct[i].length; j++) {
				if (nest.struct[i][j][0] == '=' && nest.struct[i][j][1] == chunk.length) {
					struct = nest.struct[i];
					brk = true;
					break;
				}
			}
			if (brk) break;
		}
	}
	
	var arrayed = nest.dynamicArrayed;
	var totalRead = 0;
	
	while (chunk.length > 0) {
		var read = 0;
		struct.forEach((fieldSerializor, iNumber) => {
			var type = fieldSerializor[0];
			var name = fieldSerializor[1];
			var args = fieldSerializor.slice(2);
			
			var notHide = typeof name === "string" ? !hideUnknown || !name.toLowerCase().startsWith("unknown") : false;
			
			// Modifiers:
			//     - x*nInHex* | Read array with n elements
			//     - U         | Read data as unsigned
			//     - h         | Show data as hex
			//     - m         | Show data as Enum
			//     - e         | Skip zero-filled data
			// ================|============================
			switch (type[0]) {
				case 'M': // Hash + String
				case 'S': // Char[]  (String)
					if (type.length < 3) {
						console.error(`${prefix}Invalid serializor with name ${name}: ${type}! (${iNumber})`);
						return;
					}
					
					var length = escapeHex(type.replace(/[SM]/, '0')) - 0, str;
					
					if (type[0] == 'M') {
						var pHash = int2HexBeStr(chunk.readUInt32LE());
						var str = chunk.slice(4, length).readAscii();
						var cHash = int2HexBeStr(hash(str));
						str = (pHash == cHash ? "OK" : "BAD | " + cHash) + " | " + pHash + " | " + str;
						length += 4;
					} else
						str = chunk.slice(0, length).readAscii();
					
					if (notHide) console.log(prefix + name + ':', str);
					read += length;
					chunk = chunk.slice(length);
					break;
				case 'L': // Int64   (Long)
					read += 8;
					if (type.includes("h")) { // Use hex
						if (notHide) console.log(prefix + name + ':', "0x" + long2HexBeStr(chunk.readUInt32LE(), chunk.readUInt32LE(4)));
						chunk = chunk.slice(8);
						break;
					}
					
					chunk = chunk.slice(8);
					break;
				case 'I': // Int32   (Int)
					if (type.includes("e")) { // Empty
						var i = 0;
						for (; chunk.length > 0 && chunk.readUInt32LE() == 0; i++)
							chunk = chunk.slice(4);
						
						read += i * 4;
						console.log(prefix + name + ": *Empty (" + i + ")*");
						break;
					}
				
					var value = chunk.readUInt32LE();
					chunk = chunk.slice(4);
					read += 4;
					if (!notHide) break;
					
					var displayPrefix = "";
					var display = type.includes("h") ? ("0x" + int2HexBeStr(value)) : value;
					
					if (type.includes("m")) { // Use Enum
						if (args.length >= 1 && Array.isArray(args[0])) {
							if (args[0].length > 0 && Array.isArray(args[0][0]))
							{
								let foundEntry = false;
								for (var i = 0; i < args[0].length; i++)
								{
									if (args[0][i][1] == value)
									{
										foundEntry = true;
										console.log(prefix + name + ':', displayPrefix + args[0][i][0]);
										break;
									}
								}

								if (!foundEntry)
								{
									displayPrefix = "Enum entry not present | ";
									console.log(prefix + name + ':', displayPrefix + display);
								}
							}
							else
							{
								if (args[0].length <= value) {
									displayPrefix = "Enum entry not present | ";
									console.log(prefix + name + ':', displayPrefix + display);
									break;
								}

								console.log(prefix + name + ':', displayPrefix + args[0][value]);
							}
							break;
						}
						
						displayPrefix = " Enum not present |";
					}
					
					console.log(prefix + name + ':' + displayPrefix, display);
					break;
				case 'H': // Int16   (sHort)
					if (type.includes("X")) { // Int16 Array
						console.log(prefix + name + ": Array {");
						
						var avoidTerminator = args[0].includes("+");
						
						var length;
						if (args[0][0] == "x") length = escapeHex("0" + args[0]) - 0;
						else {
							// Get array length from payload
							length = getLength(args[0]);
							var lengthChunk = chunk.slice(0, length);
							read += length;
							
							chunk = chunk.slice(length);
							length = serializeData(lengthChunk, args[0]);
						}
						read += length * 2;
						
						var displayLength = avoidTerminator ? length : length - 1;
						
						// Read array
						var line = [];
						for (var i = 0; i < length; i++) {
							var value = chunk.readUInt16LE();
							chunk = chunk.slice(2);
							line.push(type.includes("h") ? short2HexBeStr(value) : alignInt(value, 5));
							
							if (line.length == 7 || (i == displayLength - 1 && line.length > 0)) {
								console.log(prefix + "    " + line.join("  "));
								line = [];
							}
						}
						
						
						console.log(prefix + "    | Total Entries:", displayLength);
						console.log(prefix + "}");
						
						if (!avoidTerminator) {
							// Terminator
							chunk = chunk.slice(2);
						}
						
						break;
					}
					
					var value = chunk.readUInt16LE();
					chunk = chunk.slice(2);
					read += 2;
					if (!notHide) break;
					
					var display = type.includes("h") ? ("0x" + short2HexBeStr(value)) : value;
					
					console.log(prefix + name + ':', display);
					break;
				case 'Y': // Int8    (bYte)
					if (type.includes("e")) { // Empty
						var i = 0;
						for (; chunk.length > 0 && chunk.readUInt8() == 0; i++)
							chunk = chunk.slice(1);
						
						read += i;
						console.log(prefix + name + ": *Empty (" + i + ")*");
						break;
					}
					
					if (type.includes("E")) { // Skip N-bytes (Controllable Empty)
						var i = 0;
						for (; chunk.length > 0 && i < args[0]; i++)
							chunk = chunk.slice(1);
						
						read += i;
						//console.log(prefix + name + ": *Skipped bytes: " + i + "*");
						break;
					}
					
					if (type.includes("x")) {
						var length = escapeHex(type.replace("Y", "0")) - 0;
						
						console.log(prefix + name + ": Array (Size: " + length + ") {");
						
						var elems = 0;
						for (; chunk.length > 0; chunk = chunk.slice(length), elems++) {
							printBuffer(chunk.slice(0, length), prefix + "    ");
						}
						
						read += length * elems;
						console.log(prefix + "    | Total Entries:", elems);
						console.log(prefix + "}");
						break;
					}
				
					if (type.includes("M")) { // Int8 Array of Arrays
						console.log(prefix + name + ": Array {");
						
						// Read arrays
						var elems = 0;
						while (chunk.length > 0) {
							var additionalEntriesCount = chunk.readUInt16LE(10);
							var length = (additionalEntriesCount * 2 + 9) * 4;
							
							var layout = [
								["YE", null, 8],
								["H", "Visible Section Id"],
								["H", "Vertex Count"],
								["T", "Min Point", "Vector2"],
								["T", "Max Point", "Vector2"],
								["T", "Center Point", "Vector2"]
							];
							
							for (var i = 0; i < additionalEntriesCount; i++) {
								layout.push(["T", "Vertex " + (i + 1), "Vector2"]);
							}
							
							printStruct(chunk.slice(0, length), { "struct": layout }, prefix + "    ");
							console.log();
							
							chunk = chunk.slice(length);
							read += length;
							elems++;
						}
						
						console.log(prefix + "    | Total Entries:", elems);
						console.log(prefix + "}");
						break;
					}
								
					var value = chunk.readUInt8();
					chunk = chunk.slice(1);
					read++;
					if (!notHide) break;
					
					if (type.includes("m")) { // Use Enum
						var displayPrefix = "";
						if (args.length >= 1 && Array.isArray(args[0])) {
							if (args[0].length > 0 && Array.isArray(args[0][0]))
							{
								for (var i = 0; i < args[0].length; i++)
								{
									if (args[0][i][1] == value)
									{
										console.log(prefix + name + ':', displayPrefix + args[0][i][0]);
										break;
									}
								}
							}
							else
							{
								if (args[0].length <= value) {
									displayPrefix = "Enum entry not present | ";
									console.log(prefix + name + ':', displayPrefix + display);
									break;
								}

								console.log(prefix + name + ':', displayPrefix + args[0][value]);
							}
							break;
						}
						
						displayPrefix = "Enum not present | ";
					}

					var display = type.includes("h") ? ("0x" + byte2HexBeStr(value)) : value;
					
					console.log(prefix + name + ':', display);
					break;
				case 'O': // Boolean (bOol)
					if (notHide) console.log(prefix + name + ':', !!chunk[0]);
					chunk = chunk.slice(1);
					read++;
					break;
				case 'T': // Float   (floaT)
					if (args.length > 0) {
						if (args[0] == "Vector2") {
							var x = chunk.readFloatLE(0);
							var y = chunk.readFloatLE(4);
							chunk = chunk.slice(8);
							
							read += 8;
							if (notHide) console.log(prefix + name + ': Vector2{ X =', x, 'Y =', y, '}');
							break;
						}
						else if (args[0] == "Vector3") {
							var x = chunk.readFloatLE(0);
							var y = chunk.readFloatLE(4);
							var z = chunk.readFloatLE(8);
							chunk = chunk.slice(12);
							
							read += 12;
							if (notHide) console.log(prefix + name + ': Vector3{ X =', x, 'Y =', y, 'Z =', z, '}');
							break;
						}
						else if (args[0] == "Vector4") {
							var x = chunk.readFloatLE(0);
							var y = chunk.readFloatLE(4);
							var z = chunk.readFloatLE(8);
							var w = chunk.readFloatLE(12);
							chunk = chunk.slice(16);
							
							read += 16;
							if (notHide) console.log(prefix + name + ': Vector4{ X =', x, 'Y =', y, 'Z =', z, 'W =', w, '}');
							break;
						}
						else if (args[0] == "Matrix4") {
							var x1 = chunk.readFloatLE(0),  x2 = chunk.readFloatLE(16), x3 = chunk.readFloatLE(32), x4 = chunk.readFloatLE(48);
							var y1 = chunk.readFloatLE(4),  y2 = chunk.readFloatLE(20), y3 = chunk.readFloatLE(36), y4 = chunk.readFloatLE(52);
							var z1 = chunk.readFloatLE(8),  z2 = chunk.readFloatLE(24), z3 = chunk.readFloatLE(40), z4 = chunk.readFloatLE(56);
							var w1 = chunk.readFloatLE(12), w2 = chunk.readFloatLE(28), w3 = chunk.readFloatLE(44), w4 = chunk.readFloatLE(60);
							chunk = chunk.slice(64);
							
							read += 64;
							if (notHide) {
								console.log(prefix + name + ': Matrix4 {');
								
								console.log(prefix + '   ', x1, y1, z1, w1);
								console.log(prefix + '   ', x2, y2, z2, w2);
								console.log(prefix + '   ', x3, y3, z3, w3);
								console.log(prefix + '   ', x4, y4, z4, w4);
								
								console.log(prefix + '}');
							}
							break;
						}
					}
				
					read += 4;
					if (notHide) console.log(prefix + name + ':', chunk.readFloatLE());
					
					chunk = chunk.slice(4);
					break;
				case 'J': // Double  (double)
					read += 8;
					if (notHide) console.log(prefix + name + ':', chunk.readDoubleLE());
					chunk = chunk.slice(8);
					break;
				case '=': // Check for structure size
					break;
				default:
					console.error(`${prefix}Unknown serializor with name ${name}: ${type}! (${iNumber})`);
					break;
			}
		});
		
		if (!arrayed) break;
		
		totalRead += read;
		
		if (nest.structAlign && chunk.length > 0) {
			if (totalRead % nest.structAlign == 0)
				continue;
			
			var skip = nest.structAlign - (totalRead % nest.structAlign);
			totalRead += skip;
			chunk = chunk.slice(skip);
		}
	}
	
	if (chunk.length > 0) {
		console.log(prefix + "Leftovers:", buff2Str(chunk, true));
	}
}

function buff2Str(buffer, normalize) {
	var result = buffer.toString("hex").match(/.{2}/g);
	if (result == null) return "";
	result = result.join(" ");
	
	return normalize ? normalizeStr(result) : result;
}

function normalizeStr(str) {
	return (hideLong && str.length > 20 * 3 * hideMultiplier) ?
		str.slice(0, 10 * 3 * hideMultiplier) + "..." + str.slice(str.length - 10 * 3 * hideMultiplier) :
		str;
}

function long2HexBeStr(lowRegister, highRegister) {
		return int2HexBeStr(highRegister) + int2HexBeStr(lowRegister);
}

function short2HexBeStr(short) {
		let buffer = Buffer.alloc(2);
		buffer["write" + (short < 0 ? "" : "U") + "Int16BE"](short);
		return buffer.toString("hex");
}

function byte2HexBeStr(byte) {
	let buffer = Buffer.alloc(1);
	buffer.writeUInt8(byte);
	return buffer.toString('hex');
}

function serializeData(buffer, type) {
	var result = null;
	
	switch (type[0]) {
			case 'M': // Hash + String
			case 'S': // Char[]  (String)
				if (type.length < 3) {
					return;
				}
				var length = escapeHex(type.replace(/[SM]/, '0')) - 0;
				
				if (type[0] == 'M') {
					var pHash = int2HexBeStr(buffer.readUInt32LE());
					var str = buffer.slice(4, length).readAscii();
					var cHash = int2HexBeStr(hash(str));
					result = (pHash == cHash ? "OK" : "BAD | " + cHash) + " | " + pHash + " | " + str;
				} else
					result = buffer.slice(0, length).readAscii();
				break;
			case 'L': // Int64   (Long)
				if (notHide) console.log(prefix + name + ':', "0x" + long2HexBeStr(buffer.readUInt32LE(), buffer.readUInt32LE(4)));
				break;
			case 'I': // Int32   (Int)
				result = buffer.readUInt32LE();
				break;
			case 'H': // Int16   (sHort)
				result = buffer.readUInt16LE();
				break;
			case 'Y': // Int8    (bYte)
				result = buffer.readUInt8();
				break;
			case 'O': // Boolean (bOol)
				result = !!buffer[0];
				break;
			case 'T': // Float   (floaT)
				result = buffer.readFloatLE();
				break;
			case 'J': // Double  (double)
				result = buffer.readDoubleLE();
				break;
			default:
				break;
	}
	
	return result;
}

function getLength(type) {
	switch (type[0]) {
			case 'M': // Hash + String
				return type.length < 3 ? 0: escapeHex(type.replace('S', '0')) - 0 + 4;
			case 'S': // Char[]  (String)
				return type.length < 3 ? 0: escapeHex(type.replace('S', '0')) - 0;
			case 'L': // Int64   (Long)
			case 'J': // Double  (double)
				return 8;
			case 'I': // Int32   (Int)
			case 'T': // Float   (floaT)
				return 4;
			case 'H': // Int16   (sHort)
				return 2;
			case 'Y': // Int8    (bYte)
			case 'O': // Boolean (bOol)
				return 1;
			default:
				return 0;
	}
}

function alignInt(int, length) {
	var value = length - int.toString().length > 0 ? " ".repeat(length - int.toString().length) : "";
	return value + int;
}

function hash(input) {
	var hash = 0xFFFFFFFF;
	
	for (var i in input)
		hash = (hash * 33 + input[i].charCodeAt(0)) & 0xFFFFFFFF;
	
	return hash;
}

function getArgDataRaw(arg) {
	var data = null;
	var startIndex = -2;
	process.argv.forEach((elem, i) => {
		if (elem.toLowerCase() == arg.toLowerCase())
			startIndex = i;
		
		if (startIndex + 1 == i)
			data = elem;
	});
	return data;
}

function getArgDataInt(arg) {
	return parseInt(escapeHex(getArgDataRaw(arg) ?? ""))
}

function alignChunkData(chunk) {
	var payloadPrefix = 0;
	for (;chunk.length >= 4 && chunk.readUInt32LE() == 0x11111111 && (nest ? !nest.noalign : true); chunk = chunk.slice(4))
		payloadPrefix += 4;
	return {
		length: payloadPrefix,
		chunk: chunk
	};
}
