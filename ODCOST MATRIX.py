import arcpy
import os


# Output geodatabase (change to whatever local pc path)
OUTPUT_GDB = r"C:\Users\Lakshya's XPS\Documents\ArcGIS\Projects\MyProject4\Accessibility.gdb"

# Feature dataset name 
FEATURE_DATASET_NAME = "network_data"

# Input data paths (change to local pc path)
STREETS_PATH = r"C:\Users\Lakshya's XPS\Documents\ArcGIS\Projects\MyProject4\MyProject4.gdb\lion_Clip_Project_Project"
MTA_PATH = r"C:\Users\Lakshya's XPS\Documents\ArcGIS\Projects\MyProject4\MyProject4.gdb\MTA_Project"
FACILITIES_PATH = r"C:\Users\Lakshya's XPS\Documents\ArcGIS\Projects\MyProject4\MyProject4.gdb\Facilities_Database__Project"
NTA_PATH = r"C:\Users\Lakshya's XPS\Documents\ArcGIS\Projects\MyProject4\MyProject4.gdb\NTA_Polygons"  

# Walking speed (mph) - average human walking speed
WALKING_SPEED_MPH = 3

# OD Cost Matrix settings
CUTOFF_FEET = 3960   # 0.75 miles in feet
SEARCH_TOLERANCE = "5000 Feet"

# Network dataset name
NETWORK_DATASET_NAME = "StreetNetwork"

# Copy then Project 

def copy_and_project(input_fc, output_fc, spatial_ref, label):
    """Copy a feature class to detach from networks/topologies, then project."""
    temp_fc = output_fc + "_Temp"
    try:
        print(f"Copying {label}")
        arcpy.management.CopyFeatures(input_fc, temp_fc)
        print(f"Projecting {label}")
        arcpy.management.Project(temp_fc, output_fc, spatial_ref)
        print(f"{label}: {arcpy.management.GetCount(output_fc)} features")
    finally:
        if arcpy.Exists(temp_fc):
            arcpy.management.Delete(temp_fc)



# Setup


def setup():
    print("=" * 60)
    print("STEP 0: Setup")
    print("=" * 60)

    if arcpy.CheckExtension("Network") == "Available":
        arcpy.CheckOutExtension("Network")
        print("Network Analyst extension checked out.")
    else:
        raise RuntimeError("Network Analyst extension is not available.")

    if not arcpy.Exists(OUTPUT_GDB):
        gdb_folder = os.path.dirname(OUTPUT_GDB)
        gdb_name = os.path.basename(OUTPUT_GDB)
        arcpy.management.CreateFileGDB(gdb_folder, gdb_name)
        print(f"Created geodatabase: {OUTPUT_GDB}")
    else:
        print(f"Using existing geodatabase: {OUTPUT_GDB}")



# Create Feature Dataset and Import Data


def create_feature_dataset_and_import():
    print("\n" + "=" * 60)
    print("STEP 1: Create Feature Dataset and Import Data")
    print("=" * 60)

    fd_path = os.path.join(OUTPUT_GDB, FEATURE_DATASET_NAME)

    # spatial reference from streets layer
    sr = arcpy.Describe(STREETS_PATH).spatialReference
    print(f"Spatial reference: {sr.name} (WKID: {sr.factoryCode})")

    # Create feature dataset
    if not arcpy.Exists(fd_path):
        arcpy.management.CreateFeatureDataset(OUTPUT_GDB, FEATURE_DATASET_NAME, sr)
        print(f"Created feature dataset: {FEATURE_DATASET_NAME}")
    else:
        print(f"Feature dataset already exists.")

    # Streets into feature dataset
    streets_out = os.path.join(fd_path, "Streets")
    if not arcpy.Exists(streets_out):
        copy_and_project(STREETS_PATH, streets_out, sr, "Streets")
    else:
        print("Streets already imported.")

    # MTA stations into database 
    mta_out = os.path.join(OUTPUT_GDB, "MTA_Stations")
    if not arcpy.Exists(mta_out):
        copy_and_project(MTA_PATH, mta_out, sr, "MTA Stations")
    else:
        print("MTA stations already imported.")

    # Facilities into GDB
    facilities_out = os.path.join(OUTPUT_GDB, "Facilities")
    if not arcpy.Exists(facilities_out):
        copy_and_project(FACILITIES_PATH, facilities_out, sr, "Facilities")
    else:
        print("Facilities already imported.")

    # neighborhoods into GDB
    nta_out = os.path.join(OUTPUT_GDB, "NTA_Polygons")
    if NTA_PATH and not arcpy.Exists(nta_out):
        copy_and_project(NTA_PATH, nta_out, sr, "NTA Neighborhoods")
    else:
        print("NTA neighborhoods already imported or path not set.")

    return fd_path, streets_out



# Create and Build Network Dataset

def create_network(fd_path, streets_fc):
    print("\n" + "=" * 60)
    print("STEP 2: Create and Build Network Dataset")
    print("=" * 60)

    nd_path = os.path.join(fd_path, NETWORK_DATASET_NAME)
    streets_name = os.path.basename(streets_fc)

    if arcpy.Exists(nd_path):
        arcpy.management.Delete(nd_path)
        print("Deleted existing network dataset.")

    junctions_path = os.path.join(fd_path, NETWORK_DATASET_NAME + "_Junctions")
    if arcpy.Exists(junctions_path):
        arcpy.management.Delete(junctions_path)

    # Create network dataset
    print("Creating network dataset")
    arcpy.na.CreateNetworkDataset(
        fd_path,
        NETWORK_DATASET_NAME,
        [streets_name],
        "NO_ELEVATION"
    )
    print("Network dataset created.")

    # Build network
    print("Building network")
    arcpy.na.BuildNetwork(nd_path)
    print("Network built successfully.")

    return nd_path

# Create NTA Centroids


def create_centroids():
    """Convert NTA polygons to centroids for use as origins."""
    print("\n" + "=" * 60)
    print("STEP 3: Create NTA Centroids")
    print("=" * 60)

    nta_polys = os.path.join(OUTPUT_GDB, "NTA_Polygons")
    nta_centroids = os.path.join(OUTPUT_GDB, "NTA_Centroids")

    if not arcpy.Exists(nta_polys):
        print("ERROR: NTA_Polygons not found. Update NTA_PATH in config and rerun.")
        return None

    if not arcpy.Exists(nta_centroids):
        arcpy.management.FeatureToPoint(nta_polys, nta_centroids, "INSIDE")
        print(f"Created centroids: {arcpy.management.GetCount(nta_centroids)} points")
    else:
        print("NTA centroids already exist.")

    return nta_centroids

# Run OD Cost Matrix


def run_od_cost_matrix(nd_path, origins_fc, destinations_fc, output_name):
    """Run OD Cost Matrix with cutoff and export results with line geometry."""
    print("\n" + "=" * 60)
    print(f"STEP 4: Run OD Cost Matrix -> {output_name}")
    print("=" * 60)

    # Use unique layer name 
    layer_name = f"OD_{output_name}"

    # Delete existing layer if it exists in memory
    if arcpy.Exists(layer_name):
        try:
            arcpy.management.Delete(layer_name)
        except:
            pass

    # Creates OD Cost Matrix layer with cutoff and straight lines
    print(f"Creating OD Cost Matrix layer (cutoff: {CUTOFF_FEET} feet = {CUTOFF_FEET/5280:.1f} miles)")
    result = arcpy.na.MakeODCostMatrixAnalysisLayer(
        nd_path,
        layer_name,
        travel_mode=None,#change this maybe 
        cutoff=CUTOFF_FEET,
        number_of_destinations_to_find=None,
        line_shape="STRAIGHT_LINES" #change this maybe to no lines if computer is cooked
    )
    od_layer = result.getOutput(0)

    # Add Origins
    print("Adding origins")
    arcpy.na.AddLocations(od_layer, "Origins", origins_fc, "", SEARCH_TOLERANCE, append="CLEAR")
    origins_sublayer = arcpy.na.GetNASublayer(od_layer, "Origins")
    print(f"Origins loaded: {arcpy.management.GetCount(origins_sublayer)}")

    # Add Destinations
    print("Adding destinations")
    arcpy.na.AddLocations(od_layer, "Destinations", destinations_fc, "", SEARCH_TOLERANCE, append="CLEAR")
    dest_sublayer = arcpy.na.GetNASublayer(od_layer, "Destinations")
    print(f"Destinations loaded: {arcpy.management.GetCount(dest_sublayer)}")

    # Solve
    print("Solving")
    try:
        arcpy.na.Solve(od_layer, "SKIP", "CONTINUE")
        print("Solved successfully")
    except Exception as e:
        print(f"Warning during solve: {e}")

    # Export lines as feature class 
    lines_sublayer = arcpy.na.GetNASublayer(od_layer, "ODLines")
    output_fc = os.path.join(OUTPUT_GDB, output_name)
    if arcpy.Exists(output_fc):
        arcpy.management.Delete(output_fc)
    arcpy.management.CopyFeatures(lines_sublayer, output_fc)
    line_count = int(arcpy.management.GetCount(output_fc).getOutput(0))
    print(f"Exported {line_count} OD lines to {output_name}")

    
    #Add walking time field and calculate based on length and walking speed
    arcpy.management.AddField(output_fc, "WalkTime_Min", "DOUBLE")
    feet_per_minute = WALKING_SPEED_MPH * 5280 / 60  
    expression = f"!Total_Length! / {feet_per_minute}"
    arcpy.management.CalculateField(output_fc, "WalkTime_Min", expression, "PYTHON3")
    print(f"WalkTime_Min calculated ({WALKING_SPEED_MPH} mph walking speed).")

   #Stats summary 
    times = []
    with arcpy.da.SearchCursor(output_fc, ["WalkTime_Min"]) as cursor:
        for row in cursor:
            if row[0] is not None:
                times.append(row[0])
    if times:
        print(f"Walk time range: {min(times):.1f} - {max(times):.1f} minutes")
        print(f"Mean walk time: {sum(times)/len(times):.1f} minutes")
    try:
        arcpy.management.Delete(od_layer)
    except:
        pass

    return output_fc

# MAIN

def main():
    print("=" * 60)
    print("NYC ACCESSIBILITY ANALYSIS (Walking)")
    print(f"Walking speed: {WALKING_SPEED_MPH} mph | Cutoff: {CUTOFF_FEET/5280:.0f} miles")
    print("=" * 60)
    setup()

    # Import and project data
    fd_path, streets_fc = create_feature_dataset_and_import()

    # Create and build network
    nd_path = create_network(fd_path, streets_fc)

    # NTA centroids
    nta_centroids = create_centroids()
    if nta_centroids is None:
        print("\nERROR: Cannot proceed without NTA centroids. Update NTA_PATH and rerun.")
        return

    # Runs OD Cost Matrix for MTA stations
    mta_fc = os.path.join(OUTPUT_GDB, "MTA_Stations")
    od_mta = run_od_cost_matrix(nd_path, nta_centroids, mta_fc, "OD_Lines_MTA")

    # Runs OD Cost Matrix for facilities
    facilities_fc = os.path.join(OUTPUT_GDB, "Facilities")
    od_facilities = run_od_cost_matrix(nd_path, nta_centroids, facilities_fc, "OD_Lines_Facilities")

    arcpy.CheckInExtension("Network")

    # Final summary
    print("\n" + "=" * 60)
    print("COMPLETE")
    print("=" * 60)
    print(f"\nOutputs in {OUTPUT_GDB}:")
    print("  - Streets (in network_data feature dataset)")
    print("  - StreetNetwork (built network dataset)")
    print("  - NTA_Centroids (262 origin points)")
    print("  - OD_Lines_MTA (walking distance to subway stations)")
    print("  - OD_Lines_Facilities (walking distance to facilities)")
    print("\nKey field: WalkTime_Min (walking time in minutes at 3 mph)")
    print("\nNext steps:")
    print("  1. Decide on amenity categories for liveability score")
    print("  2. Calculate min walk time per origin per category")
    print("  3. Normalize, invert, and create composite score")


if __name__ == "__main__":
    main()
