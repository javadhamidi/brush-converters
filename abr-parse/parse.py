
from struct import unpack
import sys

abr = open(sys.argv[1], "rb")

# https://www.adobe.com/devnet-apps/photoshop/fileformatashtml/PhotoshopFileFormats.htm#50577411_21585
KEY_OSTYPE = {
    b'obj ': 'Reference Structure',
    b'Objc': 'Object Descriptor',
    b'VlLs': 'List',
    b'doub': 'Double',
    b'UntF': 'Unit float',
    b'TEXT': 'String',
    b'enum': 'Enumerated',
    b'long': 'Integer',
    b'comp': 'Large Integer',
    b'bool': 'Boolean',
    b'GlbO': 'GlobalObject (same as Descriptor)',
    b'type': 'Class',
    b'GlbC': 'Class',
    b'alis': 'Alias',
    b'tdta': 'Raw Data'
}

UNITS_UNTF = {
    b'#Ang': 'degrees (angle)',
    b'#Rsl': 'density (base per inch)',
    b'#Rlt': 'distance (base 72ppi)',
    b'#Nne': '(units none)',
    b'#Prc': 'percent',
    b'#Pxl': 'pixels'
}

BRUSH_PROPERTY = {
    'Dmtr': 'Diameter',
    'Hrdn': 'Hardness',
    'Angl': 'Angle',
    'Rndn': 'Roundness',
    'Spcn': 'Spacing',
    'Intr': 'Interface'
}


def unicode_string(length):
    string = ""

    for i in range(length):
        string += chr(int.from_bytes(abr.read(2), byteorder='big'))
    
    return string


def pascal_string():
    str_len = int.from_bytes(abr.read(1), byteorder='big')
    if str_len == 0:
        str_len = 4

    result = abr.read(str_len).decode("utf-8")

    if result in BRUSH_PROPERTY:
        return BRUSH_PROPERTY[result]
    
    return result 


def get_double():
    return unpack('d', abr.read(8)[::-1])[0]


def read_descriptor():
    key = abr.read(4)

    desc_type = KEY_OSTYPE[key]

    if key == b'TEXT':
        result = unicode_string(int.from_bytes(abr.read(4), byteorder='big'))

    elif key == b'UntF':
        units = UNITS_UNTF[abr.read(4)]
        result = f"{get_double()} {units}"

    elif key == b'Objc':
        if abr.read(9) != b'\x00\x00\x00\x01\x00\x00\x00\x00\x00':
            print("UNKNOWN DATA!!!")
        result = pascal_string()
        result += ", " + str(int.from_bytes(abr.read(4), byteorder='big'))
    
    elif key == b'enum':
        if int.from_bytes(abr.read(4), byteorder='big') > 0:
            print("HAVEN'T ENCOUNTERED YET!!!")
        else:
            typeID = abr.read(4).decode("utf-8")

        if int.from_bytes(abr.read(4), byteorder='big') > 0:
            print("HAVEN'T ENCOUNTERED YET!!!")
        else:
            enum = abr.read(4).decode("utf-8")
        
        result = f"({desc_type}), {typeID}, {enum}"

    elif key == b"doub":
        result = str(get_double())

    elif key == b'bool':
        result = str(ord(abr.read(1)) == True)

    elif key == b'long':
        result = int.from_bytes(abr.read(4), byteorder='big')

    else:
        result = "WARNING: " + str(key) + " type not handled!"


    result = str(result) + f" ({desc_type})"

    trailing_data = abr.read(3)
    if trailing_data == b'Obj':
        abr.seek(-3, 1)
        result += '\n\n' + read_descriptor()
    
    elif trailing_data != b'\x00\x00\x00':
        print("UNKNOWN DATA!!!!")

    return result


version = int.from_bytes(abr.read(2), byteorder='big')
subversion = int.from_bytes(abr.read(2), byteorder='big')

print(f"INFO: Brush version {version}.{subversion} found.")

if version != 6 or subversion != 2:
    exit("ERROR: Brush version is not supported, quitting!")


def parse():
    if abr.read(4) == b'8BIM':
        print("INFO: Photoshop resource signature (8BIM) found!")
    else:
        exit("ERROR: Photoshop resource signature missing, file may be of wrong type.")

    KEY = abr.read(4)
    if KEY == b'samp':
        print("""
            ---------------
            SAMPLED BRUSHES
            ---------------
        """)
        print("INFO: Photoshop 'sampled brushes' resource signature found!")
        
        LENGTH = int.from_bytes(abr.read(4), byteorder='big')
        print("\tResource length:", LENGTH, "bytes (approx.", int(LENGTH / 1000), "KB)" )

        print("\tUNKNOWN DATA!!!:", abr.read(4))

        # 'Resource ID' Pascal string, so the first bit indicates length
        ID_LEN = int.from_bytes(abr.read(1), byteorder='big')
        ID = abr.read(ID_LEN).decode("utf-8")
        print("\tResource ID:", ID)

        # From http://fileformats.archiveteam.org/wiki/Photoshop_brush#.27samp.27_block
        print("\tUNKNOWN DATA!!!:", "(Found '0001 0000')" if abr.read(4) == b'\x00\x01\x00\x00' else "(Unexpected)")

        abr.read(LENGTH - 9 - ID_LEN)  # Skip to the end (which is offset by the length subtract the length of the header) 

        parse()
        
    elif KEY == b'patt':
        print("""
            -----------------
            PATTERNS RESOURCE
            -----------------
        """)
        # From https://web.archive.org/web/20150907015455/http://www.tonton-pixel.com/Photoshop%20Additional%20File%20Formats/styles-file-format.pdf

        print("INFO: Photoshop patterns resource signature found!")

        TOTAL_LEN = int.from_bytes(abr.read(4), byteorder='big') - 14  # UNKNOWN amount of padding, guessing -14???
        print("\tTotal length of all pattern data:", TOTAL_LEN)

        while TOTAL_LEN > 0:
            print("""
                // NEW PATTERN //
            """)

            PATT_LEN = int.from_bytes(abr.read(4), byteorder='big')
            print("\tCurrent pattern data length:", PATT_LEN,
                "bytes (approx.", int(PATT_LEN / 1000), "KB)")

            print("\tPattern version:", int.from_bytes(
                abr.read(4), byteorder='big'))

            MODE = int.from_bytes(abr.read(4), byteorder='big')
            print("\tImage mode:", MODE, end=" ")

            if MODE == 0 : print("(Bitmap)")
            elif MODE == 1 : print("(Grayscale)")
            elif MODE == 2 : print("(Indexed)")
            elif MODE == 3 : print("(RGB)")
            elif MODE == 4 : print("(CMYK)")
            elif MODE == 7 : print("(Multichannel)")
            elif MODE == 8 : print("(Duotone)")
            elif MODE == 9 : print("(Lab)")

            HEIGHT = int.from_bytes(abr.read(2), byteorder='big')
            print("\tHeight:", HEIGHT)

            WIDTH = int.from_bytes(abr.read(2), byteorder='big')
            print("\tWidth:", WIDTH)

            NAME_LEN = int.from_bytes(abr.read(4), byteorder='big')
            print("\tPattern resource name:", unicode_string(NAME_LEN))

            ID_LEN = int.from_bytes(abr.read(1), byteorder='big')
            ID = abr.read(ID_LEN).decode("utf-8")
            print("\tResource ID:", ID)

            # print("Wrote resource to", ID)
            # f = open(ID, "wb")
            # f.write(abr.read(PATT_LEN - (27 + NAME_LEN + ID_LEN)))
            # f.close()

            print("""
                // PARSING VMA PATTERNS //
            """)

            # Index color table is only present when image mode is 'indexed color'
            if MODE == 2:
                COLOR_TABLE = abr.read(256 * 3)
                # print(COLOR_TABLE)
                print("UNKNOWN DATA!!!:", abr.read(4))

            print("Virtual Memory Array (VMA) Version:",
                int.from_bytes(abr.read(4), byteorder='big'), "(Expecting 3)")

            VMA_TOTAL_LEN = int.from_bytes(abr.read(4), byteorder='big')
            print("VMA Length:", VMA_TOTAL_LEN)

            RECTANGLE = {
                "top": int.from_bytes(abr.read(4), byteorder='big'),
                "left": int.from_bytes(abr.read(4), byteorder='big'),
                "bottom": int.from_bytes(abr.read(4), byteorder='big'),
                "right": int.from_bytes(abr.read(4), byteorder='big')
            }

            print("VMA Full Rectangle:", RECTANGLE)

            NUM_CHANNELS = int.from_bytes(abr.read(4), byteorder='big')
            print("VMA Number of Channels:", NUM_CHANNELS)

            # number of channels + one for a user mask + one for a sheet mask
            for i in range(NUM_CHANNELS + 2):
                # is array written
                if abr.read(4) != b'\x00\x00\x00\x00':
                    VMA_LEN = int.from_bytes(abr.read(4), byteorder='big')
                    print("Channel", i)
                    if VMA_LEN != 0:
                        print("\tVMA Pixel Depth:", int.from_bytes(
                            abr.read(4), byteorder='big'))

                        RECTANGLE = {
                            "top": int.from_bytes(abr.read(4), byteorder='big'),
                            "left": int.from_bytes(abr.read(4), byteorder='big'),
                            "bottom": int.from_bytes(abr.read(4), byteorder='big'),
                            "right": int.from_bytes(abr.read(4), byteorder='big')
                        }

                        print("\tVMA Rectangle:", RECTANGLE)

                        print("\tVMA Pixel Depth:", int.from_bytes(
                            abr.read(2), byteorder='big'))

                        print("\tVMA Compression Mode (1 is zip):",
                            int.from_bytes(abr.read(1), byteorder='big'))

                        abr.read(VMA_LEN - 23)

            TOTAL_LEN -= PATT_LEN

        # This is a total guess
        print("Trying", (TOTAL_LEN - 14) % 4, "padding bytes")
        abr.read((TOTAL_LEN - 14) % 4)

        parse()

    elif KEY == b'desc':
        print("""
            -----------------
            BRUSH DESCRIPTORS 
            -----------------
        """)

        total_len = int.from_bytes(abr.read(4), byteorder='big')
        print("Section length:", total_len, "bytes (approx.", int(total_len / 1000), "KB)" )

        section_start = abr.tell()

        print("UNKNOWN DATA!:", abr.read(25))

        pascal = pascal_string()
        if abr.read(4) == b'VlLs':  # list
            list_len = int.from_bytes(abr.read(4), byteorder='big')
            print(pascal, "found list of length " + str(list_len))
            read_descriptor()
        else:
            print("ERROR: Expected list structure!")

        while total_len > (abr.tell() - section_start):
            pascal = pascal_string()
            if pascal == 'Nm  ':
                print("\n---------------------------")
                abr.read(4)
                print(unicode_string(int.from_bytes(abr.read(4), byteorder='big')))
                abr.read(3)
                # print(pascal, read_descriptor())
                print("---------------------------")
            else:
                print(pascal, read_descriptor())
            
        parse()
    elif KEY == b'phry':
        print("""
            ----
            PHRY
            ----
        """)
    else:
        exit("ERROR: Unexpected key provided, quitting.")

parse()

abr.close()
